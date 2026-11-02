import { createHash } from 'node:crypto'
import { emptyState } from './config.js'
import { chooseInitial, usageBlocks } from './policy.js'
import { adapters } from './providers/index.js'
import { readBoundedJson } from './providers/shared.js'
import type { Account, Fetch, ProviderAdapter, ProviderID, QuotaEvidence, RouterConfig, RouterHost, RouterState, StoredCredential, UsageSnapshot } from './types.js'

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
  private readonly abort = new AbortController()

  constructor(options: { config: RouterConfig; host: RouterHost; state?: RouterState; now?: () => number; fetch?: Fetch; adapters?: Record<ProviderID, ProviderAdapter>; persist?: (state: RouterState) => Promise<void> }) {
    this.config = options.config
    this.host = options.host
    this.state = options.state ?? emptyState()
    this.now = options.now ?? Date.now
    this.fetch = options.fetch ?? globalThis.fetch
    this.adapter = options.adapters ?? adapters
    this.persist = options.persist ?? (async () => {})
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

  async refresh(provider: ProviderID, forceEvidence = false): Promise<void> {
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
      if (current && !this.selected(provider, before).some(account => account.id === current.id)) {
        this.suspended.add(provider)
        this.initialized.add(provider)
        return
      }
      await this.refresh(provider)
      const accounts = await this.host.listAccounts()
      const active = accounts.find(account => account.provider === provider && account.active)
      const selected = this.selected(provider, accounts)
      if (active && !selected.some(account => account.id === active.id)) {
        this.suspended.add(provider)
        this.initialized.add(provider)
        return
      }
      const initial = selected.filter(account => account.active || !this.blocked(provider, account.id, this.now()))
      const choice = active?.method === 'key' ? active.id : chooseInitial(settings, initial, Object.values(this.state.usage), this.now()).accountID
      if (choice) {
        if (choice !== active?.id) {
          const latest = (await this.host.listAccounts()).find(account => account.provider === provider && account.active)
          if (latest?.id !== active?.id) return
          await this.host.activate(provider, choice)
        }
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
    if (!current || !rejection || rejection.generation !== current.generation || this.now() - rejection.at > 30_000 || rejection.status !== input.error.status || digest(input.error.response?.body) !== rejection.digest || !['provider.quota', 'provider.rate-limit'].includes(input.error.type)) return false
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
      const choice = chooseInitial(settings, alternatives.map(account => ({ ...account, active: false })), Object.values(this.state.usage), now).accountID
      let next = choice
      if (!next && settings.allowPaidFallback && settings.apiKeyAccountID && settings.apiKeyModels.includes(input.model.id) && settings.accountIDs.every(id => selected.some(account => account.id === id && account.method === 'oauth' && usable(account)) && this.confirmedExhausted(provider, id, now))) {
        const key = selected.find(account => account.id === settings.apiKeyAccountID && account.method === 'key' && !account.needsAuth)
        if (key && usable(key) && !current.visited.has(key.id) && !this.blocked(provider, key.id, now)) next = key.id
      }
      if (!next) { await this.save(); return false }
      const latest = (await this.host.listAccounts()).find(account => account.provider === provider && account.active)
      if (!valid()) { discardStale(); return false }
      if (latest?.id !== rejection.accountID) { await this.save(); return false }
      const settled = await this.host.activate(provider, next)
      this.state.sticky[provider] = next
      // If the provider could not confirm the switch applied, give OpenCode's reload time first.
      input.decision = { retry: true, delay: settled === false ? 3_000 : 0 }
      await this.save()
      return true
    })
  }

  private blocked(provider: ProviderID, id: string, now: number): boolean {
    return (this.state.cooldowns[`${provider}:${id}`]?.until ?? 0) > now || usageBlocks(this.state.usage[`${provider}:${id}`], now, this.config.pollIntervalMs)
  }

  private confirmedExhausted(provider: ProviderID, id: string, now: number): boolean {
    const cooldown = this.state.cooldowns[`${provider}:${id}`]
    return !!cooldown && !cooldown.model && cooldown.until > now && cooldown.confirmedAt <= now && now - cooldown.confirmedAt <= 86_400_000
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
}

function settingsInterval(config: RouterConfig): number { return config.pollIntervalMs }
