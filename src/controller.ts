import { createHash } from 'node:crypto'
import { emptyState } from './config.js'
import { cleanLabel, describeUsage, duration } from './display.js'
import { chooseInitial, DEFAULT_CACHE_WINDOW_MS, planRebalance, usageBlocks } from './policy.js'
import { adapters } from './providers/index.js'
import { readBoundedJson } from './providers/shared.js'
import type { Account, Fetch, ProviderAdapter, ProviderConfig, ProviderID, QuotaEvidence, RouterConfig, RouterDecision, RouterHost, RouterState, StoredCredential, UsageSnapshot } from './types.js'

/** How long a quiet-moment check may hold a prompt while it brings usage up to date. */
const PREPARE_TIMEOUT_MS = 4_000
const ACTIVITY_SAVE_MS = 60_000

export interface RequestScope {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  kind: 'primary' | 'compaction' | 'title' | 'generate'
}

export interface RetryInput {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  error: { type: string; message: string; status?: number; response?: { body: string } }
  attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

interface RequestRecord { key: string; accountID?: string; primary: boolean; collision: boolean; at: number }
interface Rejection { accountID: string; status: number; digest: string; evidence: QuotaEvidence; at: number; generation: number }
interface ScopeState { records: Set<RequestRecord>; generation: number; rejection?: Rejection; visited: Set<string>; lastAttempt: number; at: number }

function providerID(id: string): ProviderID | undefined { return id === 'anthropic' || id === 'openai' ? id : undefined }
function scopeKey(scope: { sessionID: string; agent: string; model: { providerID: string; id: string } }): string {
  return JSON.stringify([scope.sessionID, scope.agent, scope.model.providerID, scope.model.id])
}
function digest(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') value = JSON.parse(value) as unknown
    if (value === null || typeof value !== 'object') return undefined
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  } catch { return undefined }
}

export class RouterController {
  readonly state: RouterState
  private readonly host: RouterHost
  private readonly config: RouterConfig
  private readonly now: () => number
  private readonly fetch: Fetch
  private readonly adapter: Record<ProviderID, ProviderAdapter>
  private readonly persist: (state: RouterState) => Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private saving: Promise<unknown> = Promise.resolve()
  private readonly polling = new Map<ProviderID, Promise<void>>()
  private readonly lastActivity = new Map<ProviderID, number>()
  private readonly initialized = new Set<ProviderID>()
  private readonly suspended = new Set<ProviderID>()
  private readonly failures = new Map<string, number>()
  private readonly probes = new Map<string, number>()
  private readonly credentials = new Map<ProviderID, { values: StoredCredential[]; at: number }>()
  private readonly reading = new Map<string, Promise<StoredCredential[]>>()
  private readonly requests = new WeakMap<Request, RequestRecord>()
  private readonly scopes = new Map<string, ScopeState>()
  private readonly reclaimed = new Map<ProviderID, number>()
  private readonly reclaiming = new Map<ProviderID, Promise<void>>()
  private readonly rebalancing = new Map<ProviderID, Promise<void>>()
  private readonly activitySaved = new Map<ProviderID, number>()
  private readonly ownerRefreshed = new Map<ProviderID, number>()
  private readonly sessions = new Set<string>()
  private readonly sessionAccounts = new Map<string, string>()
  private readonly cacheWindows = new Map<ProviderID, { ms: number; source: string }>()
  private readonly log: (decision: RouterDecision) => void
  private readonly readActivity: () => Promise<RouterState['activity']>
  private readonly abort = new AbortController()

  constructor(options: { config: RouterConfig; host: RouterHost; state?: RouterState; now?: () => number; fetch?: Fetch; adapters?: Record<ProviderID, ProviderAdapter>; persist?: (state: RouterState) => Promise<void>; log?: (decision: RouterDecision) => void; readActivity?: () => Promise<RouterState['activity']> }) {
    this.config = options.config
    this.host = options.host
    this.state = options.state ?? emptyState()
    this.now = options.now ?? Date.now
    this.fetch = options.fetch ?? globalThis.fetch
    this.adapter = options.adapters ?? adapters
    this.persist = options.persist ?? (async () => {})
    this.log = options.log ?? (() => {})
    this.readActivity = options.readActivity ?? (async () => undefined)
  }

  private record(decision: Omit<RouterDecision, 'at'>): void {
    if (this.abort.signal.aborted) return
    try { this.log({ at: this.now(), ...decision }) } catch { /* Logging never affects routing. */ }
  }

  private label(provider: ProviderID, id: string, accounts?: Account[]): string {
    const listed = accounts?.find(account => account.id === id) ?? this.credentials.get(provider)?.values.find(account => account.id === id)
    return cleanLabel(this.config.providers[provider]?.accountLabels?.[id] ?? listed?.label ?? id)
  }

  /** How long a conversation's prompt cache stays warm on this provider, and where that number came from. */
  cacheWindow(provider: ProviderID): { ms: number; source: string } {
    if (this.config.cacheWindowMs !== undefined) return { ms: this.config.cacheWindowMs, source: 'cacheWindowMs in the router config' }
    return this.cacheWindows.get(provider) ?? { ms: DEFAULT_CACHE_WINDOW_MS[provider], source: `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} default; OpenCode sends no cache.ttl` }
  }

  private async detectCacheWindow(provider: ProviderID): Promise<void> {
    if (this.config.cacheWindowMs === undefined && this.host.cacheTTL) {
      try {
        const ttl = await this.host.cacheTTL(provider)
        if (ttl !== undefined) this.cacheWindows.set(provider, { ms: Math.max(ttl, DEFAULT_CACHE_WINDOW_MS[provider]), source: `OpenCode cache.ttl setting (${duration(ttl)})` })
      } catch { /* Falls back to the provider default. */ }
    }
    const window = this.cacheWindow(provider)
    this.record({ provider, event: 'cache', reason: `Prompt cache counts as warm for ${duration(window.ms)} after a conversation request (${window.source}). Smart switches wait that long.` })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation)
    this.chain = result.catch(() => undefined)
    return result
  }

  private async save(): Promise<void> {
    const copy = structuredClone(this.state)
    this.saving = this.saving.then(() => this.persist(copy), () => this.persist(copy)).catch(() => undefined)
    await this.saving
  }

  private selected(provider: ProviderID, accounts: Account[]): Account[] {
    const config = this.config.providers[provider]
    if (!config) return []
    return accounts.filter(account => account.provider === provider && (account.method === 'oauth' && config.accountIDs.includes(account.id) || account.method === 'key' && config.allowPaidFallback && config.apiKeyAccountID === account.id))
  }

  /**
   * Cached for 30s; `force` re-reads at most every 5s and concurrent readers share one in-flight read.
   * Only `refresh` (failover) lets the credential owner refresh expired idle tokens.
   */
  private async readCredentials(provider: ProviderID, options: { force?: boolean; refresh?: boolean } = {}): Promise<StoredCredential[]> {
    const cached = this.credentials.get(provider)
    const age = cached ? this.now() - cached.at : Infinity
    if (!options.refresh && cached && (age < 5_000 || (!options.force && age < 30_000))) return cached.values
    const key = `${provider}:${options.refresh ? 'refresh' : 'read'}`
    const pending = this.reading.get(key)
    if (pending) return pending
    const config = this.config.providers[provider]
    if (!config) return []
    const operation = (async () => {
      const values = (await this.host.readCredentials(provider, { refresh: options.refresh === true })).filter(value => value.provider === provider && (value.method === 'oauth' && config.accountIDs.includes(value.id) || value.method === 'key' && config.allowPaidFallback && value.id === config.apiKeyAccountID))
      this.credentials.set(provider, { values, at: this.now() })
      return values
    })().finally(() => this.reading.delete(key))
    this.reading.set(key, operation)
    return operation
  }

  /** `retryExpired` re-checks accounts whose last check saw an expired token (after an owner refresh). */
  async refresh(provider: ProviderID, forceEvidence = false, retryExpired = false): Promise<void> {
    const settings = this.config.providers[provider]
    if (!settings || this.suspended.has(provider) || this.abort.signal.aborted) return
    const pending = this.polling.get(provider)
    if (pending) return pending
    const operation = (async () => {
      const now = this.now()
      const due = settings.accountIDs.filter(id => {
        const key = `${provider}:${id}`
        const value = this.state.usage[key]
        if (value?.retryAt && value.retryAt > now) return false
        if (forceEvidence) return now - (this.probes.get(key) ?? -Infinity) >= 60_000
        if (retryExpired && value?.status === 'expired' && now - value.checkedAt >= 60_000) return true
        return !value || now - value.checkedAt >= settingsInterval(this.config)
      })
      if (!due.length) return
      const credentials = await this.readCredentials(provider, { force: true })
      for (const id of due) {
        if (this.abort.signal.aborted) return
        const key = `${provider}:${id}`
        const credential = credentials.find(value => value.id === id && value.method === 'oauth')
        if (forceEvidence) this.probes.set(key, now)
        let usage: UsageSnapshot = credential ? await this.adapter[provider].readUsage(credential, { now, fetch: this.fetch, signal: this.abort.signal }) : { provider, accountID: id, status: 'unavailable', checkedAt: now, windows: [] }
        if (usage.status === 'rate-limited' || usage.status === 'unavailable') {
          const failures = Math.min(6, (this.failures.get(key) ?? 0) + 1)
          this.failures.set(key, failures)
          usage = { ...usage, retryAt: Math.max(usage.retryAt ?? 0, now + Math.min(3_600_000, this.config.pollIntervalMs * 2 ** (failures - 1))) }
        } else this.failures.delete(key)
        this.state.usage[key] = usage
        this.record({ provider, event: 'usage', level: usage.status === 'ok' || usage.status === 'expired' ? 'info' : 'warn', from: this.label(provider, id, credentials), reason: describeUsage(usage, now) })
      }
      await this.save()
    })().catch(() => undefined).finally(() => this.polling.delete(provider))
    this.polling.set(provider, operation)
    return operation
  }

  async initialize(provider: ProviderID): Promise<void> {
    if (!this.config.providers[provider] || this.abort.signal.aborted) return
    this.lastActivity.set(provider, this.now())
    if (this.initialized.has(provider)) return
    await this.serial(async () => {
      if (this.initialized.has(provider)) return
      const settings = this.config.providers[provider]!
      const before = await this.host.listAccounts()
      const current = before.find(account => account.provider === provider && account.active)
      // Leave a manually chosen unselected account alone, without monitoring or resolving anything.
      const pause = (account: Account): void => {
        this.suspended.add(provider)
        this.initialized.add(provider)
        this.record({ provider, event: 'pause', from: cleanLabel(account.label), reason: 'The active account is not one the router manages, so routing is paused.' })
      }
      if (current && !this.selected(provider, before).some(account => account.id === current.id)) return pause(current)
      await this.detectCacheWindow(provider)
      await this.refresh(provider)
      const accounts = await this.host.listAccounts()
      const active = accounts.find(account => account.provider === provider && account.active)
      const selected = this.selected(provider, accounts)
      if (active && !selected.some(account => account.id === active.id)) return pause(active)
      const initial = selected.filter(account => account.active || !this.blocked(provider, account.id, this.now()))
      const decision = active?.method === 'key' ? undefined : chooseInitial(settings, initial, Object.values(this.state.usage), this.now(), this.config.strategy)
      const choice = active?.method === 'key' ? active.id : decision?.accountID
      if (choice) {
        if (choice !== active?.id) {
          const latest = (await this.host.listAccounts()).find(account => account.provider === provider && account.active)
          if (latest?.id !== active?.id) return
          await this.host.activate(provider, choice)
          this.record({ provider, event: 'start', ...(active ? { from: this.label(provider, active.id, accounts) } : {}), to: this.label(provider, choice, accounts), reason: decision?.reason ?? 'Initial selection.' })
        } else this.record({ provider, event: 'start', to: this.label(provider, choice, accounts), reason: 'Router started on the account that was already active.' })
        this.state.sticky[provider] = choice
      }
      this.initialized.add(provider)
      await this.save()
    })
  }

  private prune(): void {
    const now = this.now()
    for (const [key, scope] of this.scopes) if (now - scope.at > 300_000) this.scopes.delete(key)
    while (this.scopes.size >= 1000) this.scopes.delete(this.scopes.keys().next().value!)
    for (const [provider, cache] of this.credentials) if (now - cache.at >= 60_000) this.credentials.delete(provider)
    for (const [key, cooldown] of Object.entries(this.state.cooldowns)) if (cooldown.until <= now) delete this.state.cooldowns[key]
  }

  async onRequest(scope: RequestScope, request: Request): Promise<void> {
    const provider = providerID(scope.model.providerID)
    // Suspended providers are left entirely alone: no attribution reads or monitoring.
    if (!provider || !this.config.providers[provider] || this.suspended.has(provider) || this.abort.signal.aborted) return
    this.prune()
    this.lastActivity.set(provider, this.now())
    // Conversation, compaction and session-context generation (also used by OpenCode's cache warming) keep
    // the prompt cache warm; title requests use a small separate prompt and do not.
    if (scope.kind !== 'title') this.touch(provider)
    void this.refresh(provider)
    const key = scopeKey(scope)
    const current = this.scopes.get(key) ?? { records: new Set<RequestRecord>(), generation: 0, visited: new Set<string>(), lastAttempt: 0, at: this.now() }
    current.generation++
    current.rejection = undefined
    current.at = this.now()
    this.scopes.set(key, current)
    const record: RequestRecord = { key, primary: scope.kind === 'primary', collision: current.records.size > 0, at: this.now() }
    for (const existing of current.records) existing.collision = true
    current.records.add(record)
    this.requests.set(request, record)
    const credentials = await this.readCredentials(provider)
    let matches = credentials.filter(value => this.adapter[provider].matchesRequest(value, request))
    if (!matches.length) matches = (await this.readCredentials(provider, { force: true })).filter(value => this.adapter[provider].matchesRequest(value, request))
    if (matches.length === 1) record.accountID = matches[0]!.id
    if (scope.kind === 'primary') this.noteUse(provider, scope, record.accountID, credentials)
  }

  /** Logs which account a session's conversation requests go to, once per session and whenever it changes. */
  private noteUse(provider: ProviderID, scope: RequestScope, accountID: string | undefined, credentials: StoredCredential[]): void {
    const key = `${provider}:${scope.sessionID}`
    const previous = this.sessionAccounts.get(key)
    const value = accountID ?? '?'
    if (previous === value) return
    this.sessionAccounts.delete(key)
    this.sessionAccounts.set(key, value)
    while (this.sessionAccounts.size > 1000) this.sessionAccounts.delete(this.sessionAccounts.keys().next().value!)
    if (accountID) this.record({ provider, event: 'use', to: this.label(provider, accountID, credentials), reason: `Session ${scope.sessionID} (${scope.model.id})${previous && previous !== '?' ? ` moved from ${this.label(provider, previous, credentials)}` : ''}.` })
    else this.record({ provider, event: 'use', level: 'warn', reason: `Session ${scope.sessionID} (${scope.model.id}) sent a request the router could not match to a selected account (another account, or the router loaded before the auth plugin). It will not fail over for this request.` })
  }

  async onResponse(scope: RequestScope, request: Request, response: Response): Promise<void> {
    const provider = providerID(scope.model.providerID)
    if (!provider || !this.config.providers[provider]) return
    const record = this.requests.get(request)
    const current = this.scopes.get(scopeKey(scope))
    if (current) current.rejection = undefined
    if (!record || !current || record.key !== scopeKey(scope)) return
    current.records.delete(record)
    this.requests.delete(request)
    if (response.ok || !record.primary || record.collision || !record.accountID || current.records.size || this.now() - record.at > 60_000) return
    const generation = current.generation
    const body = await readBoundedJson(response.clone(), { maxBytes: 64 * 1024, timeoutMs: 500, signal: this.abort.signal })
    if (generation !== current.generation || current.records.size) return
    const fingerprint = digest(body)
    if (!fingerprint) return
    let evidence = this.adapter[provider].classify(response.status, response.headers, body, this.now())
    if (provider === 'anthropic' && typeof body === 'object' && body !== null && 'error' in body) {
      const error = body.error
      if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.startsWith('[anthropic-auth category=subscription-usage;')) {
        const rejected = ['5h', '7d'].some(window => response.headers.get(`anthropic-ratelimit-unified-${window}-status`) === 'rejected')
        if (!rejected) {
          await this.refresh(provider, true)
          if (!usageBlocks(this.state.usage[`${provider}:${record.accountID}`], this.now(), this.config.pollIntervalMs)) evidence = { kind: 'unknown', scope: 'account' }
        }
      }
    }
    const who = this.label(provider, record.accountID)
    const resets = evidence.resetAt && evidence.resetAt > this.now() ? `, resets in ${duration(evidence.resetAt - this.now())}` : ''
    const outcomes: Record<QuotaEvidence['kind'], [RouterDecision['event'], RouterDecision['level'], string]> = {
      quota: evidence.scope === 'account' ? ['quota', 'warn', `${who} was rejected because its allowance is used up (HTTP ${response.status}${evidence.code ? `, ${evidence.code}` : ''}${resets}). Looking for another account.`] : ['ignored', 'info', `${who}: a model-specific limit (HTTP ${response.status}); not a reason to switch accounts.`],
      transient: ['ignored', 'info', `${who}: temporary rate limit or overload (HTTP ${response.status}${evidence.code ? `, ${evidence.code}` : ''}); OpenCode retries on the same account.`],
      'model-restriction': ['ignored', 'info', `${who}: this model or feature is not included in the plan (HTTP ${response.status}); switching accounts would not help.`],
      auth: ['ignored', 'warn', `${who}: sign-in was rejected (HTTP ${response.status}); OpenCode's auth plugin handles this, the router does not switch.`],
      unknown: ['ignored', 'info', `${who}: request failed (HTTP ${response.status}) for a reason that is not an account limit; left to OpenCode.`],
    }
    const [event, level, reason] = outcomes[evidence.kind]
    this.record({ provider, event, level, from: who, reason })
    if (evidence.kind !== 'quota' || evidence.scope !== 'account' || generation !== current.generation) return
    if (provider === 'openai' && response.headers.has('x-codex-active-limit') && response.headers.get('x-codex-active-limit') !== 'codex') return
    current.rejection = { accountID: record.accountID, status: response.status, digest: fingerprint, evidence, at: this.now(), generation }
  }

  async onRetry(input: RetryInput): Promise<boolean> {
    const provider = providerID(input.model.providerID)
    const settings = provider && this.config.providers[provider]
    if (!provider || !settings || this.suspended.has(provider) || this.abort.signal.aborted) return false
    const current = this.scopes.get(scopeKey(input))
    const rejection = current?.rejection
    // OpenCode reports Anthropic's 400 "credit balance is too low" as an invalid request.
    const types = ['provider.quota', 'provider.rate-limit', ...(rejection?.evidence.code === 'credit_balance' ? ['provider.invalid-request'] : [])]
    if (!current || !rejection || rejection.generation !== current.generation || this.now() - rejection.at > 30_000 || rejection.status !== input.error.status || digest(input.error.response?.body) !== rejection.digest || !types.includes(input.error.type)) return false
    current.rejection = undefined
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > Math.min(8, settings.accountIDs.length + 1)) return false
    if (input.attempt <= current.lastAttempt) current.visited.clear()
    current.lastAttempt = input.attempt
    current.visited.add(rejection.accountID)
    const valid = (): boolean => this.scopes.get(scopeKey(input)) === current && current.generation === rejection.generation && current.records.size === 0 && this.now() - rejection.at <= 30_000 && !this.abort.signal.aborted
    return this.serial(async () => {
      if (!valid()) return false
      const now = this.now()
      const reset = rejection.evidence.resetAt
      const previous = this.state.cooldowns[`${provider}:${rejection.accountID}`]
      const until = Math.max(previous && !previous.model && previous.until > now ? previous.until : 0, reset && reset > now ? Math.min(reset, now + 8 * 86_400_000) : now + this.config.pollIntervalMs)
      const accounts = await this.host.listAccounts()
      if (!valid()) return false
      const active = accounts.find(account => account.provider === provider && account.active)
      const selected = this.selected(provider, accounts)
      if (!active || !selected.some(account => account.id === active.id)) { this.suspended.add(provider); await this.save(); return false }
      const credentials = await this.readCredentials(provider, { refresh: true })
      if (!valid()) return false
      const usable = (account: Account): boolean => !account.needsAuth && credentials.some(value => value.id === account.id && value.method === account.method && !value.needsAuth && (value.method === 'key' ? !!value.key : !!value.access && (!value.expiresAt || value.expiresAt > now)))
      const confirmation = { until, confirmedAt: now }
      this.state.cooldowns[`${provider}:${rejection.accountID}`] = confirmation
      const discardStale = (): void => {
        if (this.state.cooldowns[`${provider}:${rejection.accountID}`] !== confirmation) return
        if (previous) this.state.cooldowns[`${provider}:${rejection.accountID}`] = previous
        else delete this.state.cooldowns[`${provider}:${rejection.accountID}`]
      }
      if (active.id !== rejection.accountID) {
        if (active.method !== 'oauth' || !usable(active) || current.visited.has(active.id) || this.blocked(provider, active.id, now)) return false
        input.decision = { retry: true, delay: 0 }
        await this.save()
        return true
      }
      const alternatives = selected.filter(account => account.method === 'oauth' && usable(account) && !current.visited.has(account.id) && !this.blocked(provider, account.id, now))
      const choice = chooseInitial(settings, alternatives.map(account => ({ ...account, active: false })), Object.values(this.state.usage), now, this.config.strategy).accountID
      let next = choice
      if (!next && settings.allowPaidFallback && settings.apiKeyAccountID && settings.apiKeyModels.includes(input.model.id) && settings.accountIDs.every(id => selected.some(account => account.id === id && account.method === 'oauth' && usable(account)) && this.confirmedExhausted(provider, id, now))) {
        const key = selected.find(account => account.id === settings.apiKeyAccountID && account.method === 'key' && !account.needsAuth)
        if (key && usable(key) && !current.visited.has(key.id) && !this.blocked(provider, key.id, now)) next = key.id
      }
      if (!next) {
        const why = selected.filter(account => account.method === 'oauth' && account.id !== rejection.accountID).map(account => `${this.label(provider, account.id, accounts)}: ${!usable(account) ? 'needs sign-in or its token is unavailable' : current.visited.has(account.id) ? 'already tried for this prompt' : this.blocked(provider, account.id, now) ? 'also out of allowance' : 'not usable right now'}`)
        const paid = !settings.allowPaidFallback || !settings.apiKeyAccountID ? 'paid fallback is off' : !settings.apiKeyModels.includes(input.model.id) ? `model ${input.model.id} is not on the paid-key allowlist` : 'the paid key needs every subscription to be confirmed out first'
        this.record({ provider, event: 'no-switch', level: 'warn', from: this.label(provider, rejection.accountID, accounts), reason: `Out of allowance and no safe account to move to (${[...why, paid].join('; ')}). The request ends with the provider's error.` })
        await this.save()
        return false
      }
      const latest = (await this.host.listAccounts()).find(account => account.provider === provider && account.active)
      if (!valid()) { discardStale(); return false }
      if (latest?.id !== rejection.accountID) { await this.save(); return false }
      const settled = await this.host.activate(provider, next)
      this.state.sticky[provider] = next
      this.record({ provider, event: 'failover', from: this.label(provider, rejection.accountID, accounts), to: this.label(provider, next, accounts), reason: next === settings.apiKeyAccountID ? 'Every subscription is out of allowance; using the paid key for an allowed model.' : `${this.label(provider, rejection.accountID, accounts)} hit its limit${reset && reset > now ? ` (back in ${duration(reset - now)})` : ''}.` })
      // If the provider could not confirm the switch applied, give OpenCode's reload time first.
      input.decision = { retry: true, delay: settled === false ? 3_000 : 0 }
      await this.save()
      return true
    })
  }

  /**
   * The paid key is a last resort. At a prompt boundary (never on a timer), before that prompt's requests are
   * built, move back to a selected subscription once one is signed in and no longer cooling down or reported
   * exhausted. Switches are provider-global, so another session's in-flight request may still finish on the key.
   */
  async reclaim(provider: ProviderID): Promise<void> {
    const settings = this.config.providers[provider]
    if (!settings?.allowPaidFallback || !settings.apiKeyAccountID || !this.initialized.has(provider) || this.suspended.has(provider) || this.abort.signal.aborted) return
    // Concurrent prompts wait for the same check instead of sending on the key meanwhile.
    const pending = this.reclaiming.get(provider)
    if (pending) return pending
    const keyID = settings.apiKeyAccountID
    const onKey = (accounts: Account[]): boolean => accounts.some(account => account.provider === provider && account.active && account.method === 'key' && account.id === keyID)
    const operation = (async () => {
      if (!onKey(await this.host.listAccounts())) return
      const started = this.now()
      if (started - (this.reclaimed.get(provider) ?? -Infinity) < 60_000) return
      this.reclaimed.set(provider, started)
      await this.leaveKey(provider, settings, onKey)
    })().finally(() => this.reclaiming.delete(provider))
    this.reclaiming.set(provider, operation)
    return operation
  }

  private async leaveKey(provider: ProviderID, settings: ProviderConfig, onKey: (accounts: Account[]) => boolean): Promise<void> {
    await this.refresh(provider)
    await this.serial(async () => {
      const accounts = await this.host.listAccounts()
      if (!onKey(accounts) || this.abort.signal.aborted) return
      const now = this.now()
      const candidates = this.selected(provider, accounts).filter(account => account.method === 'oauth' && !account.needsAuth && !this.blocked(provider, account.id, now))
      if (!candidates.length) return
      const credentials = await this.readCredentials(provider, { refresh: true })
      const usable = candidates.filter(account => credentials.some(value => value.id === account.id && value.method === 'oauth' && !value.needsAuth && !!value.access && (!value.expiresAt || value.expiresAt > now)))
      const choice = chooseInitial(settings, usable.map(account => ({ ...account, active: false })), Object.values(this.state.usage), now, this.config.strategy).accountID
      if (!choice || !onKey(await this.host.listAccounts())) return
      await this.host.activate(provider, choice)
      this.state.sticky[provider] = choice
      this.record({ provider, event: 'reclaim', from: this.label(provider, settings.apiKeyAccountID!, accounts), to: this.label(provider, choice, accounts), reason: 'A subscription is usable again, so the paid key is no longer needed.' })
      await this.save()
    })
  }

  private blocked(provider: ProviderID, id: string, now: number): boolean {
    return (this.state.cooldowns[`${provider}:${id}`]?.until ?? 0) > now || usageBlocks(this.state.usage[`${provider}:${id}`], now, this.config.pollIntervalMs)
  }

  private confirmedExhausted(provider: ProviderID, id: string, now: number): boolean {
    const cooldown = this.state.cooldowns[`${provider}:${id}`]
    return !!cooldown && !cooldown.model && cooldown.until > now && cooldown.confirmedAt <= now && now - cooldown.confirmedAt <= 86_400_000
  }

  private touch(provider: ProviderID): void {
    const now = this.now()
    const activity = this.state.activity ??= {}
    activity[provider] = Math.max(activity[provider] ?? 0, now)
    // Persisted (throttled) so a restart or another OpenCode process still sees the warm cache.
    if (now - (this.activitySaved.get(provider) ?? -Infinity) < ACTIVITY_SAVE_MS) return
    this.activitySaved.set(provider, now)
    void this.save()
  }

  /** Time since the last conversation request on this provider, from any session or router process. */
  private async quietFor(provider: ProviderID, includeShared: boolean): Promise<number> {
    if (includeShared) {
      try {
        const shared = (await this.readActivity())?.[provider]
        if (shared !== undefined && shared <= this.now()) {
          const activity = this.state.activity ??= {}
          activity[provider] = Math.max(activity[provider] ?? 0, shared)
        }
      } catch { /* Unreadable shared state only means we rely on what this process saw. */ }
    }
    const last = this.state.activity?.[provider]
    return last === undefined ? Infinity : this.now() - last
  }

  /**
   * Smart routing, called at every prompt boundary before that prompt's requests are built. Switching
   * drops the provider prompt cache, so it only happens when no conversation request has gone out on
   * this provider for `cacheWindowMs` (a new session after a break, or work resuming after idling), or
   * when the active account is already out of allowance and its cache is lost anyway. Mid-conversation,
   * failover in `onRetry` stays the only way accounts change.
   */
  async rebalance(provider: ProviderID, sessionID?: string): Promise<void> {
    const settings = this.config.providers[provider]
    if (!settings || this.config.strategy !== 'smart' || !this.initialized.has(provider) || this.suspended.has(provider) || this.abort.signal.aborted) return
    const firstPrompt = sessionID !== undefined && !this.sessions.has(sessionID)
    if (sessionID !== undefined) {
      this.sessions.add(sessionID)
      while (this.sessions.size > 1000) this.sessions.delete(this.sessions.values().next().value!)
    }
    const pending = this.rebalancing.get(provider)
    if (pending) return pending
    const operation = this.evaluate(provider, settings, firstPrompt).catch(() => undefined).finally(() => this.rebalancing.delete(provider))
    this.rebalancing.set(provider, operation)
    return operation
  }

  private async evaluate(provider: ProviderID, settings: ProviderConfig, firstPrompt: boolean): Promise<void> {
    const accounts = await this.host.listAccounts()
    const active = accounts.find(account => account.provider === provider && account.active)
    // The paid key is reclaim's job; unselected or signed-out accounts are left alone.
    if (!active || active.method !== 'oauth' || active.needsAuth || !this.selected(provider, accounts).some(account => account.id === active.id)) return
    const window = this.cacheWindow(provider).ms
    let quiet = await this.quietFor(provider, false)
    if (quiet >= window) quiet = await this.quietFor(provider, true)
    const exhausted = this.blocked(provider, active.id, this.now())
    if (quiet < window && !exhausted) {
      const ago = duration(quiet) === 'now' ? 'moments ago' : `${duration(quiet)} ago`
      if (firstPrompt) this.record({ provider, event: 'wait', from: this.label(provider, active.id, accounts), reason: `New session, but a conversation used this account ${ago}; switching now would drop its prompt cache.` })
      return
    }
    await this.within(this.prepare(provider, settings), PREPARE_TIMEOUT_MS)
    await this.serial(async () => {
      if (this.abort.signal.aborted) return
      const now = this.now()
      const latest = await this.host.listAccounts()
      const current = latest.find(account => account.provider === provider && account.active)
      if (current?.id !== active.id || current.method !== 'oauth') return
      const blocked = this.blocked(provider, current.id, now)
      // A conversation (here or in another router process) may have started while usage was being refreshed.
      if (!blocked && (await this.quietFor(provider, true)) < window) return
      const labeled = (account: Account): Account => ({ ...account, label: this.label(provider, account.id, latest) })
      const candidates = this.selected(provider, latest).filter(account => account.method === 'oauth' && !account.needsAuth && account.id !== current.id && !this.blocked(provider, account.id, now))
      const plan = planRebalance(settings, labeled(current), candidates.map(labeled), Object.values(this.state.usage), now, { maxAge: this.config.pollIntervalMs, currentBlocked: blocked })
      if (!plan.accountID) {
        this.record({ provider, event: 'keep', from: this.label(provider, current.id, latest), reason: plan.reason })
        return
      }
      await this.host.activate(provider, plan.accountID)
      this.state.sticky[provider] = plan.accountID
      this.record({ provider, event: 'switch', from: this.label(provider, current.id, latest), to: this.label(provider, plan.accountID, latest), reason: plan.reason })
      await this.save()
    })
  }

  /** Brings usage up to date for a quiet-moment decision; idle accounts' expired tokens are refreshed by OpenCode at most once per poll interval. */
  private async prepare(provider: ProviderID, settings: ProviderConfig): Promise<void> {
    const now = this.now()
    const expired = settings.accountIDs.some(id => this.state.usage[`${provider}:${id}`]?.status === 'expired')
    if (expired && now - (this.ownerRefreshed.get(provider) ?? -Infinity) >= this.config.pollIntervalMs) {
      this.ownerRefreshed.set(provider, now)
      await this.readCredentials(provider, { refresh: true })
    }
    await this.refresh(provider, false, expired)
  }

  private async within(operation: Promise<unknown>, milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })
    try { await Promise.race([operation.catch(() => undefined), limit]) } finally { clearTimeout(timer) }
  }

  async tick(): Promise<void> {
    this.prune()
    for (const [provider, at] of this.lastActivity) if (this.now() - at < this.config.idleTimeoutMs) await this.refresh(provider)
  }

  stop(): void {
    this.abort.abort()
    this.credentials.clear()
    this.scopes.clear()
  }

  /** Persists activity still inside the save throttle, then resolves once queued state writes have finished. */
  async drain(): Promise<void> {
    const unsaved = (Object.entries(this.state.activity ?? {}) as [ProviderID, number | undefined][]).filter(([provider, at]) => at !== undefined && at > (this.activitySaved.get(provider) ?? -Infinity))
    for (const [provider, at] of unsaved) this.activitySaved.set(provider, at!)
    if (unsaved.length) await this.save()
    await this.saving
  }
}

function settingsInterval(config: RouterConfig): number { return config.pollIntervalMs }
