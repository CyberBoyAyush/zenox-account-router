import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState, parseConfig } from '../src/config.js'
import { RouterController } from '../src/controller.js'
import { DEFAULT_CACHE_WINDOW_MS } from '../src/policy.js'
import type { RequestScope, RetryInput } from '../src/controller.js'
import type { Account, Fetch, ProviderConfig, ProviderID, RouterDecision, RouterHost, RouterState, RoutingStrategy, StoredCredential, UsageSnapshot } from '../src/types.js'

const epoch = Date.parse('2026-11-02T12:00:00Z')
const interval = 600_000
const providers = ['anthropic', 'openai'] as const
const controllers: RouterController[] = []
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()) })

function credential(provider: ProviderID, id: string, overrides: Partial<StoredCredential> = {}): StoredCredential {
  return { id, provider, label: `Synthetic ${id}`, method: id === 'key' ? 'key' : 'oauth', active: id === 'a', ...(id === 'key' ? { key: `synthetic-${provider}-paid-secret` } : { access: `synthetic-${provider}-${id}-secret`, expiresAt: epoch + 10 * 86_400_000 }), ...(provider === 'openai' && id !== 'key' ? { metadata: { accountID: `workspace-${id}` } } : {}), ...overrides }
}

function snapshot(provider: ProviderID, id: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { provider, accountID: id, checkedAt: epoch, status: 'ok', windows: [], ...overrides }
}

function monitorBody(provider: ProviderID, now: number, used = 20): unknown {
  return provider === 'anthropic'
    ? { five_hour: { utilization: used, resets_at: new Date(now + 18_000_000).toISOString() }, seven_day: { utilization: used, resets_at: new Date(now + 604_800_000).toISOString() } }
    : { rate_limit: { allowed: used < 100, primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: (now + 18_000_000) / 1000 }, secondary_window: { used_percent: used, limit_window_seconds: 604_800, reset_at: (now + 604_800_000) / 1000 } } }
}

function quota(provider: ProviderID, now: number): { body: string; headers: HeadersInit } {
  return provider === 'anthropic'
    ? { body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Weekly usage limit reached' } }), headers: { 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': String((now + 3_600_000) / 1000) } }
    : { body: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: (now + 3_600_000) / 1000 } }), headers: { 'x-codex-active-limit': 'codex' } }
}

function fixture(provider: ProviderID, options: { settings?: Partial<ProviderConfig>; state?: RouterState; cold?: boolean; idleTimeoutMs?: number; pollIntervalMs?: number; strategy?: RoutingStrategy; cacheWindowMs?: number; readActivity?: () => Promise<RouterState['activity']>; cacheTTL?: RouterHost['cacheTTL'] } = {}) {
  let now = epoch
  const settings: ProviderConfig = { accountIDs: ['a', 'b'], allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['model'], ...options.settings }
  const config = parseConfig({ version: 1, pollIntervalMs: options.pollIntervalMs ?? interval, idleTimeoutMs: options.idleTimeoutMs ?? interval, ...(options.strategy ? { strategy: options.strategy } : {}), ...(options.cacheWindowMs ? { cacheWindowMs: options.cacheWindowMs } : {}), providers: { [provider]: settings } })
  const decisions: RouterDecision[] = []
  const credentials = [...settings.accountIDs.map(id => credential(provider, id)), credential(provider, 'key'), credential(provider, 'outside', { active: false })]
  const accounts: Account[] = credentials.map(({ id, provider, label, method, active, needsAuth }) => ({ id, provider, label, method, active, ...(needsAuth ? { needsAuth } : {}) }))
  const state = options.state ?? emptyState()
  if (!options.cold && !options.state) for (const id of settings.accountIDs) state.usage[`${provider}:${id}`] = snapshot(provider, id)
  let monitor: (headers: Headers) => Response | Promise<Response> = () => new Response(JSON.stringify(monitorBody(provider, now)))
  const fetch = vi.fn<Fetch>(async (input, init) => {
    expect(String(input)).toBe(provider === 'anthropic' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage')
    expect(init?.method).toBe('GET')
    return monitor(new Headers(init?.headers))
  })
  const activate = vi.fn<RouterHost['activate']>(async (targetProvider, id) => {
    expect(targetProvider).toBe(provider)
    expect(accounts.some(account => account.id === id)).toBe(true)
    for (const account of accounts) if (account.provider === targetProvider) account.active = account.id === id
  })
  const readCredentials = vi.fn<RouterHost['readCredentials']>(async target => structuredClone(credentials.filter(value => value.provider === target)))
  const listAccounts = vi.fn<RouterHost['listAccounts']>(async () => structuredClone(accounts))
  const persist = vi.fn<(value: RouterState) => Promise<void>>(async () => {})
  const controller = new RouterController({ config, state, host: { activate, readCredentials, listAccounts, ...(options.cacheTTL ? { cacheTTL: options.cacheTTL } : {}) }, fetch, now: () => now, persist, log: decision => { decisions.push(decision) }, ...(options.readActivity ? { readActivity: options.readActivity } : {}) })
  controllers.push(controller)
  const scope: RequestScope = { sessionID: 'session', agent: 'build', model: { providerID: provider, id: 'model' }, kind: 'primary' }
  function request(id = 'a', headers?: HeadersInit): Request {
    const value = credentials.find(item => item.id === id)
    if (!value) throw new Error(`Missing synthetic credential ${id}`)
    const auth: Record<string, string> = provider === 'anthropic' && value.method === 'key' ? { 'x-api-key': value.key ?? '' } : { Authorization: `Bearer ${value.method === 'key' ? value.key : value.access}` }
    if (provider === 'openai' && value.method === 'oauth') auth['ChatGPT-Account-Id'] = String(value.metadata?.accountID)
    return new Request(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: headers ?? auth, body: JSON.stringify({ model: 'model', messages: [] }) })
  }
  function retry(body = quota(provider, now).body, overrides: Partial<RetryInput> = {}): RetryInput {
    return { sessionID: scope.sessionID, agent: scope.agent, model: scope.model, attempt: 1, error: { type: 'provider.quota', message: 'Synthetic quota rejection', status: 429, response: { body } }, decision: { retry: false }, ...overrides }
  }
  async function reject(id = 'a', options: { scope?: RequestScope; status?: number; body?: string; headers?: HeadersInit; request?: Request; attempt?: number } = {}) {
    const usedScope = options.scope ?? scope
    const outgoing = options.request ?? request(id)
    const evidence = quota(provider, now)
    const body = options.body ?? evidence.body
    const status = options.status ?? 429
    await controller.onRequest(usedScope, outgoing)
    await controller.refresh(provider)
    const response = new Response(body, { status, headers: options.headers ?? evidence.headers })
    await controller.onResponse(usedScope, outgoing, response)
    return { response, request: outgoing, input: retry(body, { sessionID: usedScope.sessionID, agent: usedScope.agent, model: usedScope.model, attempt: options.attempt ?? 1, error: { type: 'provider.quota', message: 'Synthetic quota rejection', status, response: { body } } }) }
  }
  return { provider, config, settings, state, accounts, credentials, controller, fetch, activate, persist, readCredentials, listAccounts, scope, request, retry, reject, decisions, now: () => now, advance: (milliseconds: number) => { now += milliseconds }, setMonitor: (value: typeof monitor) => { monitor = value }, setActive: (id: string) => { for (const account of accounts) account.active = account.id === id } }
}

describe('upstream Anthropic diagnostic corroboration', () => {
  const body = JSON.stringify({ error: { type: 'rate_limit_error', message: '[anthropic-auth category=subscription-usage; active=hidden] Anthropic reports that this account has reached a subscription or usage limit.' } })

  it('corroborates a rewritten quota diagnostic before switching', async () => {
    const f = fixture('anthropic')
    f.setMonitor(headers => new Response(JSON.stringify(monitorBody('anthropic', f.now(), headers.get('authorization')?.endsWith('-a-secret') ? 100 : 20))))
    const { input } = await f.reject('a', { body, headers: { 'x-should-retry': 'false' } })
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b'])
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not switch when the canonical message is not corroborated by ordinary allowance exhaustion', async () => {
    const f = fixture('anthropic')
    const { input } = await f.reject('a', { body, headers: {} })
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not mistake a throttled corroboration probe for exhaustion or repeat it during backoff', async () => {
    const f = fixture('anthropic')
    f.setMonitor(() => new Response(null, { status: 429, headers: { 'retry-after': '1200' } }))
    expect(await f.controller.onRetry((await f.reject('a', { body, headers: {} })).input)).toBe(false)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(60_000)
    expect(await f.controller.onRetry((await f.reject('a', { body, headers: {} })).input)).toBe(false)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.activate).not.toHaveBeenCalled()
  })
})

describe.each(providers)('%s quota-driven routing with actual provider adapters', provider => {
  it('routes A quota → B quota → allowlisted key, then stops on key exhaustion without cycling', async () => {
    const f = fixture(provider)
    await f.controller.initialize(provider)
    for (const [index, id] of ['a', 'b', 'key'].entries()) {
      const { input } = await f.reject(id, { attempt: index + 1 })
      expect(await f.controller.onRetry(input)).toBe(index < 2)
      expect(input.decision).toEqual(index < 2 ? { retry: true, delay: 0 } : { retry: false })
    }
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key'])
    expect(f.state.sticky[provider]).toBe('key')
    expect(Object.keys(f.state.cooldowns).sort()).toEqual([`${provider}:a`, `${provider}:b`, `${provider}:key`])
    expect(f.state.cooldowns[`${provider}:a`]).toEqual({ until: epoch + 3_600_000, confirmedAt: epoch })
  })

  it.each(['payment disabled', 'model not allowlisted'] as const)('stops after subscriptions when %s', async reason => {
    const f = fixture(provider, { settings: reason === 'payment disabled' ? { allowPaidFallback: false } : { apiKeyModels: ['different-model'] } })
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(true)
    const last = (await f.reject('b', { attempt: 2 })).input
    expect(await f.controller.onRetry(last)).toBe(false)
    expect(last.decision).toEqual({ retry: false })
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b'])
  })

  it.each(['missing', 'unavailable', 'stale'] as const)('does not authorize paid fallback from %s OAuth monitoring evidence', async kind => {
    const f = fixture(provider)
    f.credentials.splice(f.credentials.findIndex(value => value.id === 'b'), 1)
    if (kind === 'missing') delete f.state.usage[`${provider}:b`]
    else f.state.usage[`${provider}:b`] = snapshot(provider, 'b', { status: kind === 'unavailable' ? 'unavailable' : 'ok', checkedAt: kind === 'stale' ? epoch - interval - 1 : epoch, retryAt: epoch + interval, allowed: false })
    const { input } = await f.reject()
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not accept stale, model-scoped, future or expired cooldowns as proof for paid fallback', async () => {
    for (const invalid of [ { until: epoch + 60_000, confirmedAt: epoch - 86_400_001 }, { until: epoch + 60_000, confirmedAt: epoch, model: 'model' }, { until: epoch + 60_000, confirmedAt: epoch + 1 }, { until: epoch, confirmedAt: epoch - 1 } ]) {
      const f = fixture(provider)
      f.credentials.splice(f.credentials.findIndex(value => value.id === 'b'), 1)
      f.state.cooldowns[`${provider}:b`] = invalid
      expect(await f.controller.onRetry((await f.reject()).input), JSON.stringify(invalid)).toBe(false)
      expect(f.activate).not.toHaveBeenCalled()
    }
  })

  it.each(['revoked', 'deleted', 'missing credential', 'expired credential'] as const)('does not select a %s alternative or an unselected outsider', async kind => {
    const f = fixture(provider)
    const candidate = f.accounts.find(value => value.id === 'b')!
    if (kind === 'revoked') candidate.needsAuth = true
    if (kind === 'deleted') f.accounts.splice(f.accounts.indexOf(candidate), 1)
    if (kind === 'missing credential') f.credentials.splice(f.credentials.findIndex(value => value.id === 'b'), 1)
    if (kind === 'expired credential') f.credentials.find(value => value.id === 'b')!.expiresAt = epoch
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('matches the outgoing credential, not the currently active account', async () => {
    const f = fixture(provider)
    const { input } = await f.reject('b')
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(f.state.cooldowns[`${provider}:b`]).toBeDefined()
    expect(f.state.cooldowns[`${provider}:a`]).toBeUndefined()
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('fails closed for wrong outgoing auth, wrong origins, and monitoring requests', async () => {
    const f = fixture(provider)
    const url = provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses'
    for (const outgoing of [new Request(url, { headers: { Authorization: 'Bearer unrelated-token' } }), new Request('https://untrusted.invalid/v1/messages', { headers: { Authorization: `Bearer ${f.credentials[0]!.access}` } }), new Request(provider === 'anthropic' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage', { headers: { Authorization: `Bearer ${f.credentials[0]!.access}` } })]) {
      expect(await f.controller.onRetry((await f.reject('a', { request: outgoing })).input)).toBe(false)
    }
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.state.cooldowns).toEqual({})
  })

  it('does not rotate on generic 429, auth 401/403, model restriction or 200 SSE failure', async () => {
    const f = fixture(provider)
    const cases: Array<{ status: number; body: string; headers: HeadersInit }> = [
      { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Too many requests' } }), headers: {} },
      ...[401, 403].map(status => ({ status, body: quota(provider, epoch).body, headers: quota(provider, epoch).headers })),
      { status: 429, body: JSON.stringify({ error: { type: 'usage_not_included', message: 'Model-specific usage limit reached' } }), headers: {} },
      { status: 200, body: `event: error\ndata: ${quota(provider, epoch).body}\n\n`, headers: { 'content-type': 'text/event-stream' } },
    ]
    for (const options of cases) expect(await f.controller.onRetry((await f.reject('a', options)).input), `status=${options.status} ${options.body}`).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.state.cooldowns).toEqual({})
  })

  it.each(['title', 'compaction', 'generate'] as const)('does not rotate or attribute %s failures to the primary request', async kind => {
    const f = fixture(provider)
    const { input } = await f.reject('a', { scope: { ...f.scope, kind } })
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.state.cooldowns).toEqual({})
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('invalidates all overlapping requests in the same scope, including primary plus title', async () => {
    for (const kind of ['primary', 'title'] as const) {
      const f = fixture(provider)
      const first = f.request(), second = f.request()
      await f.controller.onRequest(f.scope, first)
      await f.controller.onRequest({ ...f.scope, kind }, second)
      const evidence = quota(provider, epoch)
      for (const outgoing of [first, second]) await f.controller.onResponse(f.scope, outgoing, new Response(evidence.body, { status: 429, headers: evidence.headers }))
      expect(await f.controller.onRetry(f.retry(evidence.body))).toBe(false)
      expect(f.state.cooldowns).toEqual({})
    }
  })

  it('isolates a distinct agent/session/model scope and never consumes its rejection elsewhere', async () => {
    for (const different of [{ sessionID: 'other-session' }, { agent: 'other-agent' }, { model: { providerID: provider, id: 'other-model' } }]) {
      const f = fixture(provider)
      const { input } = await f.reject()
      expect(await f.controller.onRetry({ ...input, ...different })).toBe(false)
      expect(await f.controller.onRetry(input)).toBe(true)
    }
  })

  it('rejects fingerprint, HTTP status, error category, malformed and missing body mismatches', async () => {
    const mutations: Array<(input: RetryInput) => void> = [
      input => { input.error.response = { body: JSON.stringify({ error: { type: 'usage_limit_reached', unrelated: true } }) } },
      input => { input.error.status = 400 },
      input => { input.error.type = 'provider.auth' },
      input => { input.error.response = { body: '{' } },
      input => { delete input.error.response },
    ]
    for (const mutate of mutations) {
      const f = fixture(provider)
      const { input } = await f.reject()
      mutate(input)
      expect(await f.controller.onRetry(input)).toBe(false)
      expect(f.activate).not.toHaveBeenCalled()
      expect(f.state.cooldowns).toEqual({})
    }
  })

  it('expires rejection evidence after 30 seconds and request attribution after 60 seconds', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.advance(30_001)
    expect(await f.controller.onRetry(input)).toBe(false)
    const outgoing = f.request()
    await f.controller.onRequest(f.scope, outgoing)
    f.advance(60_001)
    const evidence = quota(provider, f.now())
    await f.controller.onResponse(f.scope, outgoing, new Response(evidence.body, { status: 429, headers: evidence.headers }))
    expect(await f.controller.onRetry(f.retry(evidence.body))).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('uses a response clone without consuming the original or the outgoing request', async () => {
    const f = fixture(provider)
    const { response, request, input } = await f.reject()
    expect(response.bodyUsed).toBe(false)
    expect(request.bodyUsed).toBe(false)
    expect(await response.text()).toBe(input.error.response?.body)
    expect(await request.json()).toEqual({ model: 'model', messages: [] })
    expect(await f.controller.onRetry(input)).toBe(true)
  })

  it('fails closed when a later hook replaces the actual Request object', async () => {
    const f = fixture(provider)
    const original = f.request()
    await f.controller.onRequest(f.scope, original)
    const replacement = new Request(original)
    const evidence = quota(provider, epoch)
    await f.controller.onResponse(f.scope, replacement, new Response(evidence.body, { status: 429, headers: evidence.headers }))
    expect(await f.controller.onRetry(f.retry())).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('fails closed when selected credentials have duplicate matching tokens', async () => {
    const f = fixture(provider)
    const a = f.credentials.find(value => value.id === 'a')!, b = f.credentials.find(value => value.id === 'b')!
    b.access = a.access
    b.metadata = a.metadata
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('rereads rotated credentials immediately when a cached token no longer matches', async () => {
    const f = fixture(provider)
    const first = f.request()
    await f.controller.onRequest(f.scope, first)
    await f.controller.onResponse(f.scope, first, new Response('{}'))
    const before = f.readCredentials.mock.calls.length
    f.credentials.find(value => value.id === 'a')!.access = 'synthetic-rotated-access-secret'
    // Forced re-reads are rate limited to one per 5 seconds.
    f.advance(5_000)
    const { input } = await f.reject()
    expect(f.readCredentials.mock.calls.length).toBeGreaterThan(before)
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(f.state.cooldowns[`${provider}:a`]).toBeDefined()
  })

  it.each([0, -1, 1.5, 4, 9, NaN, Infinity])('fails closed for invalid/out-of-budget attempt %s', async attempt => {
    const f = fixture(provider)
    const { input } = await f.reject('a', { attempt })
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.state.cooldowns).toEqual({})
  })

  it('caps even a large selected pool at eight retry attempts', async () => {
    const f = fixture(provider, { settings: { accountIDs: ['a', 'b', ...Array.from({ length: 9 }, (_, index) => `extra-${index}`)] } })
    let active = 'a'
    for (let attempt = 1; attempt <= 9; attempt++) {
      const { input } = await f.reject(active, { attempt })
      expect(await f.controller.onRetry(input), `attempt=${attempt}`).toBe(attempt <= 8)
      active = f.accounts.find(account => account.active)!.id
    }
    expect(f.activate).toHaveBeenCalledTimes(8)
    expect(new Set(f.activate.mock.calls.map(call => call[1])).size).toBe(8)
  })

  it('does not revisit an already attempted subscription even after its cooldown expires', async () => {
    const f = fixture(provider, { settings: { allowPaidFallback: false } })
    const shortReset = provider === 'anthropic'
      ? { headers: { 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': String((epoch + 1_000) / 1000) } }
      : { body: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: (epoch + 1_000) / 1000 } }) }
    expect(await f.controller.onRetry((await f.reject('a', { attempt: 1, ...shortReset })).input)).toBe(true)
    f.advance(1_001)
    expect(await f.controller.onRetry((await f.reject('b', { attempt: 2 })).input)).toBe(false)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b'])
  })

  it('consumes rejection evidence exactly once under simultaneous retry hooks', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    expect(await Promise.all([f.controller.onRetry(input), f.controller.onRetry(structuredClone(input))])).toEqual([true, false])
    expect(f.activate).toHaveBeenCalledOnce()
  })

  it('respects a concurrent external A→B switch without activating or undoing it', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.setActive('b')
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(input.decision).toEqual({ retry: true, delay: 0 })
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.accounts.find(account => account.active)?.id).toBe('b')
  })

  it('suspends routing after an external switch to an unselected account', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.setActive('outside')
    expect(await f.controller.onRetry(input)).toBe(false)
    f.setActive('a')
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('respects an initially unselected active account and does not silently resume routing', async () => {
    const f = fixture(provider)
    f.setActive('outside')
    await f.controller.initialize(provider)
    f.setActive('a')
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('exhaustively activates selected OAuth only, or an explicitly allowed selected key after all OAuth is rejected', async () => {
    for (let mask = 0; mask < 64; mask++) {
      const hasB = !!(mask & 1), revokedB = !!(mask & 2), missingB = !!(mask & 4)
      const paid = !!(mask & 8), allowedModel = !!(mask & 16), revokedKey = !!(mask & 32)
      const f = fixture(provider, { settings: { accountIDs: hasB ? ['a', 'b'] : ['a'], allowPaidFallback: paid, apiKeyModels: [allowedModel ? 'model' : 'other-model'] } })
      if (hasB && revokedB) f.accounts.find(value => value.id === 'b')!.needsAuth = true
      if (hasB && missingB) f.credentials.splice(f.credentials.findIndex(value => value.id === 'b'), 1)
      if (revokedKey) f.accounts.find(value => value.id === 'key')!.needsAuth = true
      const expected = hasB && !revokedB && !missingB ? 'b' : !hasB && paid && allowedModel && !revokedKey ? 'key' : undefined
      const { input } = await f.reject()
      expect(await f.controller.onRetry(input), `mask=${mask}`).toBe(expected !== undefined)
      expect(f.activate.mock.calls.map(call => call[1]), `mask=${mask}`).toEqual(expected ? [expected] : [])
      if (expected === 'key') {
        expect(f.settings.allowPaidFallback).toBe(true)
        expect(f.settings.apiKeyModels).toContain(input.model.id)
        expect(f.settings.accountIDs.every(id => !!f.state.cooldowns[`${provider}:${id}`])).toBe(true)
      }
    }
  })

  it('invalidates a completed rejection when any newer request starts in that scope', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    const newer = f.request()
    await f.controller.onRequest(f.scope, newer)
    expect(await f.controller.onRetry(input)).toBe(false)
    await f.controller.onResponse(f.scope, newer, new Response('{}'))
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not override an external switch discovered during final preactivation recheck', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.listAccounts.mockImplementationOnce(async () => structuredClone(f.accounts)).mockImplementationOnce(async () => { f.setActive('outside'); return structuredClone(f.accounts) })
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.accounts.find(account => account.active)?.id).toBe('outside')
  })

  it('persists cooldowns and honors them after constructing a new controller', async () => {
    const first = fixture(provider)
    expect(await first.controller.onRetry((await first.reject()).input)).toBe(true)
    const persisted = structuredClone(first.persist.mock.calls.at(-1)![0])
    const second = fixture(provider, { state: persisted, settings: { allowPaidFallback: false } })
    second.setActive('b')
    expect(await second.controller.onRetry((await second.reject('b')).input)).toBe(false)
    expect(second.activate).not.toHaveBeenCalled()
    expect(second.state.cooldowns[`${provider}:a`]).toEqual({ until: epoch + 3_600_000, confirmedAt: epoch })
  })

  it('preserves a known weekly cooldown when a later rejection omits its reset', async () => {
    const f = fixture(provider)
    f.state.cooldowns[`${provider}:a`] = { until: epoch + 7 * 86_400_000, confirmedAt: epoch - 1000 }
    const body = JSON.stringify({ error: provider === 'anthropic' ? { type: 'rate_limit_error', message: 'Weekly usage limit reached' } : { type: 'usage_limit_reached' } })
    expect(await f.controller.onRetry((await f.reject('a', { body, headers: {} })).input)).toBe(true)
    expect(f.state.cooldowns[`${provider}:a`]?.until).toBe(epoch + 7 * 86_400_000)
  })

  it.each(['deleted', 'expired', 'revoked'] as const)('does not pay based on retained exhaustion proof for an account now %s', async condition => {
    const f = fixture(provider)
    f.state.cooldowns[`${provider}:b`] = { until: epoch + 3_600_000, confirmedAt: epoch - 1000 }
    if (condition === 'deleted') {
      f.accounts.splice(f.accounts.findIndex(account => account.id === 'b'), 1)
      f.credentials.splice(f.credentials.findIndex(account => account.id === 'b'), 1)
    } else if (condition === 'expired') f.credentials.find(account => account.id === 'b')!.expiresAt = epoch - 1
    else f.credentials.find(account => account.id === 'b')!.needsAuth = true
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it.each(['account read', 'credential read'] as const)('invalidates a retry when newer successful traffic arrives during its %s', async boundary => {
    const f = fixture(provider)
    const { input } = await f.reject()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    if (boundary === 'account read') f.listAccounts.mockImplementationOnce(async () => { entered(); await gate; return structuredClone(f.accounts) })
    else f.readCredentials.mockImplementationOnce(async () => { entered(); await gate; return structuredClone(f.credentials) })
    const pending = f.controller.onRetry(input)
    await started
    const newer = f.request()
    await f.controller.onRequest(f.scope, newer)
    await f.controller.onResponse(f.scope, newer, new Response('{}'))
    release()
    expect(await pending).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
    expect(input.decision).toEqual({ retry: false })
  })

  it('does not initialize onto a persisted cooling-down favorite when no account is active', async () => {
    const state = emptyState()
    state.cooldowns[`${provider}:a`] = { until: epoch + 60_000, confirmedAt: epoch }
    state.usage[`${provider}:a`] = snapshot(provider, 'a')
    state.usage[`${provider}:b`] = snapshot(provider, 'b')
    const f = fixture(provider, { state, settings: { favoriteAccountID: 'a' } })
    f.setActive('none')
    await f.controller.initialize(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b'])
    expect(f.state.sticky[provider]).toBe('b')
  })

  it('never attributes a response to a different scope than its registered Request', async () => {
    const f = fixture(provider)
    const original = f.request()
    const otherScope = { ...f.scope, sessionID: 'other-session' }
    const other = f.request()
    await f.controller.onRequest(f.scope, original)
    await f.controller.onRequest(otherScope, other)
    await f.controller.onResponse(otherScope, other, new Response('{}'))
    const evidence = quota(provider, epoch)
    await f.controller.onResponse(otherScope, original, new Response(evidence.body, { status: 429, headers: evidence.headers }))
    const input = f.retry(evidence.body, { sessionID: otherScope.sessionID })
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.state.cooldowns).toEqual({})
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('rechecks credential revocation before selecting an otherwise listed candidate', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.credentials.find(value => value.id === 'b')!.needsAuth = true
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not authorize retry on a concurrently selected but revoked subscription', async () => {
    const f = fixture(provider)
    const { input } = await f.reject()
    f.setActive('b')
    f.accounts.find(value => value.id === 'b')!.needsAuth = true
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('keeps a live selection sticky despite fresh 100% monitoring, a favorite, and timer refreshes', async () => {
    const f = fixture(provider, { settings: { favoriteAccountID: 'b' }, idleTimeoutMs: interval * 3 })
    f.setMonitor(() => new Response(JSON.stringify(monitorBody(provider, f.now(), 100))))
    await f.controller.initialize(provider)
    f.advance(interval)
    await f.controller.tick()
    await f.controller.initialize(provider)
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.state.sticky[provider]).toBe('a')
    expect(f.state.cooldowns).toEqual({})
  })

  it('does not rebalance to A when cooldown expiry or monitoring later shows more allowance', async () => {
    const f = fixture(provider, { idleTimeoutMs: 8_000_000 })
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(true)
    f.advance(3_600_001)
    await f.controller.tick()
    await f.controller.initialize(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b'])
    expect(f.state.sticky[provider]).toBe('b')
    expect(f.state.cooldowns[`${provider}:a`]).toBeUndefined()
  })

  async function onPaidKey(f: ReturnType<typeof fixture>): Promise<void> {
    await f.controller.initialize(provider)
    expect(await f.controller.onRetry((await f.reject('a')).input)).toBe(true)
    expect(await f.controller.onRetry((await f.reject('b', { attempt: 2 })).input)).toBe(true)
    expect(f.accounts.find(account => account.active)?.id).toBe('key')
  }

  it('returns from the paid key to a subscription at the next prompt once one is usable again', async () => {
    const f = fixture(provider)
    await onPaidKey(f)
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key'])
    f.advance(3_600_001)
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key', 'a'])
    expect(f.state.sticky[provider]).toBe('a')
    expect(f.persist.mock.calls.at(-1)?.[0].sticky[provider]).toBe('a')
  })

  it('prefers the favorite subscription when leaving the paid key', async () => {
    const f = fixture(provider, { settings: { favoriteAccountID: 'b' } })
    await onPaidKey(f)
    f.advance(3_600_001)
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.at(-1)?.[1]).toBe('b')
  })

  it.each(['reported exhausted', 'signed out', 'expired token'] as const)('stays on the paid key while every subscription is %s', async kind => {
    const f = fixture(provider)
    await onPaidKey(f)
    f.advance(3_600_001)
    if (kind === 'reported exhausted') f.setMonitor(() => new Response(JSON.stringify(monitorBody(provider, f.now(), 100))))
    for (const id of ['a', 'b']) {
      if (kind === 'signed out') f.accounts.find(account => account.id === id)!.needsAuth = true
      if (kind === 'expired token') f.credentials.find(value => value.id === id)!.expiresAt = f.now()
    }
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key'])
    expect(f.state.sticky[provider]).toBe('key')
  })

  it('checks for a return at most once a minute', async () => {
    const f = fixture(provider)
    await onPaidKey(f)
    f.advance(3_600_001)
    f.setMonitor(() => new Response(JSON.stringify(monitorBody(provider, f.now(), 100))))
    await f.controller.reclaim(provider)
    for (const id of ['a', 'b']) delete f.state.usage[`${provider}:${id}`]
    f.advance(59_000)
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key'])
    f.advance(1_000)
    f.setMonitor(() => new Response(JSON.stringify(monitorBody(provider, f.now()))))
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.at(-1)?.[1]).toBe('a')
  })

  it('does not let prompts made on a subscription delay leaving the key', async () => {
    const f = fixture(provider)
    await f.controller.initialize(provider)
    await f.controller.reclaim(provider)
    await onPaidKey(f)
    f.state.cooldowns = {}
    await f.controller.reclaim(provider)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key', 'a'])
  })

  it('makes concurrent prompts wait for one shared return instead of sending on the key', async () => {
    const f = fixture(provider)
    await onPaidKey(f)
    f.advance(3_600_001)
    const seen: string[] = []
    await Promise.all([0, 1, 2].map(async () => { await f.controller.reclaim(provider); seen.push(f.accounts.find(account => account.active)!.id) }))
    expect(seen).toEqual(['a', 'a', 'a'])
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key', 'a'])
  })

  it('leaves a subscription or an unauthorized key alone', async () => {
    const onSubscription = fixture(provider)
    await onSubscription.controller.initialize(provider)
    await onSubscription.controller.reclaim(provider)
    expect(onSubscription.activate).not.toHaveBeenCalled()
    const unauthorized = fixture(provider, { settings: { allowPaidFallback: false, apiKeyAccountID: undefined, apiKeyModels: [] } })
    unauthorized.setActive('key')
    await unauthorized.controller.initialize(provider)
    await unauthorized.controller.reclaim(provider)
    expect(unauthorized.activate).not.toHaveBeenCalled()
  })

  it('fails over from a paid key that runs out of credit back to a usable subscription', async () => {
    const f = fixture(provider)
    await onPaidKey(f)
    f.advance(3_600_001)
    const body = provider === 'anthropic'
      ? JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } })
      : JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota.' } })
    const status = provider === 'anthropic' ? 400 : 429
    const { input } = await f.reject('key', { body, status, headers: {} })
    input.error.type = provider === 'anthropic' ? 'provider.invalid-request' : 'provider.quota'
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(input.decision).toEqual({ retry: true, delay: 0 })
    expect(f.activate.mock.calls.at(-1)?.[1]).toBe('a')
  })

  it('does not treat an ordinary invalid request as a reason to leave the paid key', async () => {
    const f = fixture(provider)
    await onPaidKey(f)
    f.advance(3_600_001)
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } })
    const { input } = await f.reject('key', { body, status: 400, headers: {} })
    input.error.type = 'provider.invalid-request'
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'key'])
  })

  it('never persists access tokens, API keys, credential metadata, request/response bodies or auth headers', async () => {
    const f = fixture(provider, { cold: true })
    await f.controller.initialize(provider)
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(true)
    const serialized = JSON.stringify(f.persist.mock.calls)
    for (const value of f.credentials) {
      if (value.access) expect(serialized).not.toContain(value.access)
      if (value.key) expect(serialized).not.toContain(value.key)
    }
    for (const forbidden of ['workspace-', 'Authorization', 'Bearer ', 'Weekly usage limit reached', 'usage_limit_reached', 'metadata', 'messages']) expect(serialized).not.toContain(forbidden)
    expect(f.persist.mock.calls.every(([state]) => ['activity,cooldowns,sticky,usage,version', 'cooldowns,sticky,usage,version'].includes(Object.keys(state).sort().join(',')))).toBe(true)
    // Activity is only a per-provider timestamp.
    expect(f.persist.mock.calls.every(([state]) => Object.entries(state.activity ?? {}).every(([key, value]) => key === provider && typeof value === 'number'))).toBe(true)
  })
})

describe.each(providers)('%s monitoring scheduling', provider => {
  it('single-flights concurrent refreshes and polls OAuth only every ten minutes', async () => {
    const f = fixture(provider, { cold: true })
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f.setMonitor(async () => { await gate; return new Response(JSON.stringify(monitorBody(provider, f.now()))) })
    const pending = [f.controller.refresh(provider), f.controller.refresh(provider), f.controller.refresh(provider)]
    await Promise.resolve()
    await Promise.resolve()
    release!()
    await Promise.all(pending)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    await f.controller.refresh(provider)
    f.advance(interval - 1)
    await f.controller.refresh(provider)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(1)
    await f.controller.refresh(provider)
    expect(f.fetch).toHaveBeenCalledTimes(4)
    expect(f.fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).get('authorization')?.includes('paid-secret'))).toBe(true)
    expect(f.state.usage[`${provider}:key`]).toBeUndefined()
    expect(f.state.usage[`${provider}:outside`]).toBeUndefined()
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('gates timer polling on activity and resumes after a request', async () => {
    const f = fixture(provider, { cold: true })
    await f.controller.tick()
    expect(f.fetch).not.toHaveBeenCalled()
    await f.controller.initialize(provider)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(interval)
    await f.controller.tick()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    const outgoing = f.request()
    await f.controller.onRequest(f.scope, outgoing)
    await f.controller.refresh(provider)
    expect(f.fetch).toHaveBeenCalledTimes(4)
    await f.controller.onResponse(f.scope, outgoing, new Response('{}'))
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('treats monitoring 429 as backoff only, honors Retry-After and increases repeated-failure delay', async () => {
    const f = fixture(provider, { cold: true, idleTimeoutMs: 86_400_000 })
    f.setMonitor(() => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Weekly usage limit reached' } }), { status: 429, headers: { 'retry-after': '1800' } }))
    await f.controller.initialize(provider)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.state.usage[`${provider}:a`]).toMatchObject({ status: 'rate-limited', retryAt: epoch + 1_800_000 })
    f.advance(1_799_999)
    await f.controller.tick()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(1)
    await f.controller.tick()
    expect(f.fetch).toHaveBeenCalledTimes(4)
    f.setMonitor(() => new Response('{}', { status: 429 }))
    f.advance(1_800_000)
    await f.controller.tick()
    expect(f.state.usage[`${provider}:a`]?.retryAt).toBe(f.now() + 2_400_000)
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.state.cooldowns).toEqual({})
    expect(await f.controller.onRetry(f.retry())).toBe(false)
  })

  it('honors the configured interval instead of a hardcoded timer', async () => {
    const f = fixture(provider, { cold: true, pollIntervalMs: 300_000, idleTimeoutMs: 1_800_000 })
    await f.controller.initialize(provider)
    f.advance(299_999)
    await f.controller.tick()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.advance(1)
    await f.controller.tick()
    expect(f.fetch).toHaveBeenCalledTimes(4)
  })

  it('stops all polling and retries after shutdown', async () => {
    const f = fixture(provider, { cold: true })
    const { input } = await f.reject()
    const calls = f.fetch.mock.calls.length
    f.controller.stop()
    f.advance(interval)
    await f.controller.tick()
    await f.controller.refresh(provider)
    await f.controller.initialize(provider)
    await f.controller.onRequest(f.scope, f.request())
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    expect(f.activate).not.toHaveBeenCalled()
  })
})

describe('provider-specific attribution guards', () => {
  it('requires OpenAI outgoing workspace identity as well as the bearer token', async () => {
    const f = fixture('openai')
    for (const workspace of ['workspace-b', '']) {
      const request = f.request('a', { Authorization: `Bearer ${f.credentials[0]!.access}`, 'ChatGPT-Account-Id': workspace })
      expect(await f.controller.onRetry((await f.reject('a', { request })).input)).toBe(false)
    }
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('rejects an OpenAI quota response explicitly attributed to a different active limit', async () => {
    const f = fixture('openai')
    expect(await f.controller.onRetry((await f.reject('a', { headers: { 'x-codex-active-limit': 'other-model' } })).input)).toBe(false)
    expect(f.state.cooldowns).toEqual({})
  })

  it('requires matching Anthropic x-api-key on paid requests rather than OAuth-style Bearer', async () => {
    const f = fixture('anthropic')
    const invalid = f.request('key', { Authorization: `Bearer ${f.credentials.find(value => value.id === 'key')!.key}` })
    expect(await f.controller.onRetry((await f.reject('key', { request: invalid })).input)).toBe(false)
    expect(f.state.cooldowns).toEqual({})
  })
})

describe.each(providers)('%s credential read discipline under unattributable traffic', provider => {
  it('many concurrent unattributable requests share one forced read, then rate-limit further forced reads', async () => {
    const f = fixture(provider)
    await f.controller.initialize(provider)
    const baseline = f.readCredentials.mock.calls.length
    const unknown = () => new Request(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { authorization: 'Bearer synthetic-unknown-token' }, body: '{}' })
    await Promise.all(Array.from({ length: 20 }, (_, index) => f.controller.onRequest({ ...f.scope, sessionID: `s${index}` }, unknown())))
    expect(f.readCredentials.mock.calls.length - baseline).toBeLessThanOrEqual(1)
    f.advance(1_000)
    for (let index = 0; index < 10; index++) await f.controller.onRequest({ ...f.scope, sessionID: `t${index}` }, unknown())
    expect(f.readCredentials.mock.calls.length - baseline).toBeLessThanOrEqual(1)
    // Monitoring and attribution never ask the owner to refresh; only failover does.
    expect(f.readCredentials.mock.calls.every(([, options]) => options?.refresh !== true)).toBe(true)
  })

  it('a suspended provider performs no credential reads or monitoring on requests', async () => {
    const f = fixture(provider)
    f.setActive('outside')
    await f.controller.initialize(provider)
    const reads = f.readCredentials.mock.calls.length
    const fetches = f.fetch.mock.calls.length
    for (let index = 0; index < 10; index++) await f.controller.onRequest(f.scope, f.request('outside'))
    f.advance(interval * 2)
    await f.controller.tick()
    expect(f.readCredentials.mock.calls.length).toBe(reads)
    expect(f.fetch.mock.calls.length).toBe(fetches)
  })

  it('failover reads explicitly allow owner refresh of idle backups', async () => {
    const f = fixture(provider)
    expect(await f.controller.onRetry((await f.reject()).input)).toBe(true)
    expect(f.readCredentials.mock.calls.some(([, options]) => options?.refresh === true)).toBe(true)
  })

  it('delays the retry when the host cannot confirm the switch applied', async () => {
    const f = fixture(provider)
    f.activate.mockImplementationOnce(async (_provider, id) => { f.setActive(id); return false })
    const { input } = await f.reject()
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(input.decision).toEqual({ retry: true, delay: 3_000 })
  })
})

type Fixture = ReturnType<typeof fixture>
type Windows = { session: number | null; weekly?: number | null; used?: number; weeklyUsed?: number }

/** Usage per account (by bearer token): 5-hour and weekly resets as offsets from the fixture's clock. */
function usageBy(f: Fixture, plan: Record<string, Windows>): (headers: Headers) => Response {
  return headers => {
    const auth = headers.get('authorization') ?? ''
    const entry = Object.entries(plan).find(([id]) => auth.endsWith(`-${id}-secret`))?.[1] ?? { session: 18_000_000 }
    const now = f.now()
    const used = entry.used ?? 20
    const weeklyUsed = entry.weeklyUsed ?? 30
    const session = entry.session === null ? null : now + entry.session
    const weekly = entry.weekly === null ? null : now + (entry.weekly ?? 604_800_000)
    const body = f.provider === 'anthropic'
      ? { five_hour: { utilization: entry.session === null ? 0 : used, resets_at: session === null ? null : new Date(session).toISOString() }, seven_day: { utilization: weeklyUsed, resets_at: weekly === null ? null : new Date(weekly).toISOString() } }
      : { rate_limit: { allowed: used < 100 && weeklyUsed < 100, primary_window: { used_percent: entry.session === null ? 0 : used, limit_window_seconds: 18_000, reset_at: session === null ? null : session / 1000 }, secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604_800, reset_at: weekly === null ? null : weekly / 1000 } } }
    return new Response(JSON.stringify(body))
  }
}

const hours = (value: number): number => value * 3_600_000
const minutes = (value: number): number => value * 60_000
// The user's real numbers: the active account's 5-hour window resets in 3h42m, the standby's in 1h42m.
const userCase = { a: { session: hours(3) + minutes(42), weekly: hours(116) }, b: { session: hours(1) + minutes(42), weekly: hours(95) } }

function scopeFor(f: Fixture, sessionID: string, kind: RequestScope['kind'] = 'primary'): RequestScope {
  return { ...f.scope, sessionID, kind }
}

async function converse(f: Fixture, sessionID = 'busy', kind: RequestScope['kind'] = 'primary', id = 'a'): Promise<void> {
  const scope = scopeFor(f, sessionID, kind)
  const outgoing = f.request(id)
  await f.controller.onRequest(scope, outgoing)
  await f.controller.onResponse(scope, outgoing, new Response('{}', { status: 200 }))
}

describe.each(providers)('%s smart routing at cache-safe prompts', provider => {
  // Anthropic's default prompt cache lasts 5 minutes, OpenAI's 30 minutes.
  const cache = DEFAULT_CACHE_WINDOW_MS[provider]
  async function started(options: Parameters<typeof fixture>[1] = {}, plan: Record<string, Windows> = userCase) {
    const f = fixture(provider, { cold: true, ...options })
    f.setMonitor(usageBy(f, plan))
    await f.controller.initialize(provider)
    return f
  }

  it('moves a new conversation after a quiet period to the account whose 5-hour allowance expires first', async () => {
    const f = await started()
    expect(f.activate).not.toHaveBeenCalled()
    await f.controller.rebalance(provider, 'new-thread')
    expect(f.activate.mock.calls).toEqual([[provider, 'b']])
    expect(f.state.sticky[provider]).toBe('b')
    const decision = f.decisions.find(item => item.event === 'switch')
    expect(decision).toMatchObject({ provider, from: 'Synthetic a', to: 'Synthetic b' })
    expect(decision?.reason).toBe("Synthetic b's 5-hour window resets in 1h 42m, Synthetic a's in 3h 42m; use the allowance that expires first.")
    expect(f.persist).toHaveBeenLastCalledWith(expect.objectContaining({ sticky: { [provider]: 'b' } }))
  })

  it('also checks an existing conversation that resumes after its cache expired', async () => {
    const f = await started()
    await f.controller.rebalance(provider, 'thread')
    expect(f.activate).toHaveBeenCalledTimes(1)
    await converse(f, 'thread', 'primary', 'b')
    // The other account's window comes back around and now expires first.
    f.setMonitor(usageBy(f, { a: { session: minutes(40) }, b: { session: hours(4) } }))
    f.advance(Math.max(interval, cache) + 1)
    await f.controller.rebalance(provider, 'thread')
    expect(f.activate.mock.calls.map(call => call[1])).toEqual(['b', 'a'])
    expect(f.decisions.filter(item => item.event === 'switch').map(item => item.to)).toEqual(['Synthetic b', 'Synthetic a'])
  })

  it('waits while another conversation has a warm prompt cache, then switches once it has gone quiet', async () => {
    const f = await started()
    await converse(f)
    f.advance(cache - minutes(1))
    await f.controller.rebalance(provider, 'new-thread')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.decisions.at(-1)).toMatchObject({ event: 'wait', from: 'Synthetic a' })
    expect(f.decisions.at(-1)?.reason).toContain(`${(cache - minutes(1)) / 60_000}m ago`)
    // Later prompts of the same session are not logged again while waiting.
    await f.controller.rebalance(provider, 'new-thread')
    expect(f.decisions.filter(item => item.event === 'wait')).toHaveLength(1)
    f.advance(minutes(1) - 1)
    await f.controller.rebalance(provider, 'new-thread')
    expect(f.activate).not.toHaveBeenCalled()
    f.advance(1)
    await f.controller.rebalance(provider, 'new-thread')
    expect(f.activate.mock.calls).toEqual([[provider, 'b']])
  })

  it('counts compaction and session generation (OpenCode cache warming) as cache traffic, but not title requests', async () => {
    for (const kind of ['compaction', 'generate'] as const) {
      const warm = await started()
      await converse(warm, 'other', kind)
      await warm.controller.rebalance(provider, 'new')
      expect(warm.activate, kind).not.toHaveBeenCalled()
    }
    const f = await started()
    await converse(f, 'other', 'title')
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('honours a configured longer cache window (for example a 1-hour prompt cache)', async () => {
    const f = await started({ cacheWindowMs: hours(1) })
    await converse(f)
    f.advance(minutes(30))
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    f.advance(minutes(30))
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('keeps the active account when the other expires less than 30 minutes sooner, and says why', async () => {
    const f = await started({}, { a: { session: hours(2) }, b: { session: hours(2) - minutes(29) } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.decisions.at(-1)).toMatchObject({ event: 'keep', from: 'Synthetic a' })
    const g = await started({}, { a: { session: hours(2) }, b: { session: hours(2) - minutes(30) } })
    await g.controller.rebalance(provider, 'new')
    expect(g.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('keeps the active account when its own allowance expires first', async () => {
    const f = await started({}, { a: { session: hours(1) }, b: { session: hours(4) } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.decisions.at(-1)?.reason).toContain("Synthetic a's 5-hour window resets first")
  })

  it('prefers a running 5-hour window over starting a fresh one', async () => {
    const f = await started({}, { a: { session: null }, b: { session: hours(4) } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    const g = await started({}, { a: { session: hours(4) }, b: { session: null } })
    await g.controller.rebalance(provider, 'new')
    expect(g.activate).not.toHaveBeenCalled()
  })

  it('uses the weekly reset when neither 5-hour window is running', async () => {
    const f = await started({}, { a: { session: null, weekly: hours(100) }, b: { session: null, weekly: hours(80) } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    const g = await started({}, { a: { session: null, weekly: hours(100) }, b: { session: null, weekly: hours(90) } })
    await g.controller.rebalance(provider, 'new')
    expect(g.activate).not.toHaveBeenCalled()
  })

  it('never moves to an account that is out of allowance or nearly out', async () => {
    for (const b of [{ session: minutes(10), used: 100 }, { session: minutes(10), used: 96 }, { session: minutes(10), weeklyUsed: 100 }]) {
      const f = await started({}, { a: { session: hours(4) }, b })
      await f.controller.rebalance(provider, 'new')
      expect(f.activate, JSON.stringify(b)).not.toHaveBeenCalled()
    }
  })

  it('moves off an exhausted active account even while a conversation is warm, since its cache is unusable anyway', async () => {
    const f = await started({}, { a: { session: hours(4), used: 100 }, b: { session: hours(4) } })
    await converse(f)
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    expect(f.decisions.at(-1)?.reason).toBe('Synthetic a is out of allowance.')
  })

  it('moves off an active account with a confirmed cooldown', async () => {
    const f = await started({}, { a: { session: hours(4) }, b: { session: hours(4) } })
    f.state.cooldowns[`${provider}:a`] = { until: f.now() + hours(1), confirmedAt: f.now() }
    await converse(f)
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('moves off an active account with less than 5% left once quiet', async () => {
    const f = await started({}, { a: { session: hours(4), used: 96 }, b: { session: hours(4) } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    expect(f.decisions.at(-1)?.reason).toBe('Synthetic a has under 5% left.')
  })

  it('does nothing with sticky strategy, before initialization, after stop, or for a suspended router', async () => {
    const sticky = await started({ strategy: 'sticky' })
    await sticky.controller.rebalance(provider, 'new')
    expect(sticky.activate).not.toHaveBeenCalled()
    const early = fixture(provider, { cold: true })
    early.setMonitor(usageBy(early, userCase))
    await early.controller.rebalance(provider, 'new')
    expect(early.activate).not.toHaveBeenCalled()
    expect(early.listAccounts).not.toHaveBeenCalled()
    const stopped = await started()
    stopped.controller.stop()
    await stopped.controller.rebalance(provider, 'new')
    expect(stopped.activate).not.toHaveBeenCalled()
    const suspended = fixture(provider, { cold: true })
    suspended.setActive('outside')
    await suspended.controller.initialize(provider)
    await suspended.controller.rebalance(provider, 'new')
    expect(suspended.activate).not.toHaveBeenCalled()
    expect(suspended.fetch).not.toHaveBeenCalled()
    expect(suspended.decisions.map(item => item.event)).toEqual(['pause'])
  })

  it('leaves the paid key to reclaim and never activates the key or an unselected account', async () => {
    const f = await started({}, { a: { session: hours(4) }, b: { session: minutes(30) } })
    f.setActive('key')
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    const g = await started({ settings: { allowPaidFallback: false, apiKeyAccountID: undefined, apiKeyModels: [] } })
    await g.controller.rebalance(provider, 'new')
    expect(g.activate.mock.calls.every(([, id]) => id === 'a' || id === 'b')).toBe(true)
  })

  it('switches exactly once when several prompts arrive together', async () => {
    const f = await started()
    await Promise.all(['one', 'two', 'three'].map(id => f.controller.rebalance(provider, id)))
    await f.controller.rebalance(provider, 'four')
    expect(f.activate.mock.calls).toEqual([[provider, 'b']])
  })

  it('cancels the switch when a conversation starts while usage is being refreshed', async () => {
    const f = await started()
    f.advance(interval + 1)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetched = new Promise<void>(resolve => { f.setMonitor(async headers => { resolve(); await gate; return usageBy(f, userCase)(headers) }) })
    const pending = f.controller.rebalance(provider, 'new')
    await fetched
    await converse(f, 'other')
    release()
    await pending
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not switch when the active account changes while usage is being refreshed', async () => {
    const f = await started()
    f.advance(interval + 1)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetched = new Promise<void>(resolve => { f.setMonitor(async headers => { resolve(); await gate; return usageBy(f, userCase)(headers) }) })
    const pending = f.controller.rebalance(provider, 'new')
    await fetched
    f.setActive('b')
    release()
    await pending
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('holds a prompt at most about four seconds when the usage endpoint hangs, then keeps the account on stale data', async () => {
    const f = await started()
    f.advance(interval + 1)
    f.setMonitor(() => new Promise<Response>(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let done = false
      const pending = f.controller.rebalance(provider, 'new').then(() => { done = true })
      await vi.advanceTimersByTimeAsync(3_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(done).toBe(true)
    } finally { vi.useRealTimers() }
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.decisions.at(-1)?.reason).toBe('No recent usage for Synthetic b yet.')
  })

  it('treats activity saved by a previous run as warm, so a restart does not drop a live cache', async () => {
    const state = emptyState()
    state.activity = { [provider]: epoch - cache + minutes(3) }
    const f = fixture(provider, { state })
    f.setMonitor(usageBy(f, userCase))
    await f.controller.initialize(provider)
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    f.advance(minutes(3))
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it("respects another OpenCode process's recent activity from the shared state file", async () => {
    let shared: number | undefined = epoch - cache + minutes(4)
    const f = await started({ readActivity: async () => (shared === undefined ? undefined : { [provider]: shared }) })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    // A future timestamp from a skewed clock is ignored rather than blocking routing forever.
    shared = epoch + hours(24)
    f.advance(minutes(5))
    expect(f.activate).not.toHaveBeenCalled()
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('re-reads shared activity right before switching, in case another process started a conversation meanwhile', async () => {
    let reads = 0
    const f = await started({ readActivity: async () => (++reads >= 2 ? { [provider]: epoch } : undefined) })
    await f.controller.rebalance(provider, 'new')
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('persists activity still inside the save throttle when draining on shutdown', async () => {
    const f = await started()
    await converse(f)
    f.advance(20_000)
    await converse(f)
    expect(f.persist.mock.calls.at(-1)?.[0].activity?.[provider]).toBe(epoch)
    f.controller.stop()
    await f.controller.drain()
    expect(f.persist.mock.calls.at(-1)?.[0].activity?.[provider]).toBe(epoch + 20_000)
    const calls = f.persist.mock.calls.length
    await f.controller.drain()
    expect(f.persist.mock.calls.length).toBe(calls)
  })

  it('ignores an unreadable shared state file', async () => {
    const f = await started({ readActivity: async () => { throw new Error('unreadable') } })
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('lets OpenCode refresh an idle expired token at most once per poll interval, then routes on fresh usage', async () => {
    const f = fixture(provider, { cold: true })
    const stale = f.credentials.find(value => value.id === 'b')!
    stale.expiresAt = epoch - 1
    f.readCredentials.mockImplementation(async (target, options) => structuredClone(f.credentials.filter(value => value.provider === target).map(value => value.id === 'b' && options?.refresh ? { ...value, expiresAt: epoch + hours(8) } : value)))
    f.setMonitor(usageBy(f, userCase))
    await f.controller.initialize(provider)
    expect(f.state.usage[`${provider}:b`]?.status).toBe('expired')
    f.advance(minutes(1))
    await f.controller.rebalance(provider, 'new')
    expect(f.readCredentials.mock.calls.filter(([, options]) => options?.refresh)).toHaveLength(1)
    expect(f.state.usage[`${provider}:b`]?.status).toBe('ok')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    const g = fixture(provider, { cold: true })
    g.credentials.find(value => value.id === 'b')!.expiresAt = epoch - 1
    g.setMonitor(usageBy(g, userCase))
    await g.controller.initialize(provider)
    for (let index = 0; index < 4; index++) {
      g.advance(minutes(2))
      await g.controller.rebalance(provider, `new-${index}`)
    }
    // OpenCode could not refresh it, so the router asked once and never moved to an account it cannot see.
    expect(g.readCredentials.mock.calls.filter(([, options]) => options?.refresh)).toHaveLength(1)
    expect(g.activate).not.toHaveBeenCalled()
  })

  it('saves conversation activity at most once a minute', async () => {
    const f = await started()
    const before = f.persist.mock.calls.length
    // Three minutes of steady traffic, one request a second.
    for (let index = 0; index < 180; index++) {
      await converse(f, 'busy')
      f.advance(1_000)
    }
    const saves = f.persist.mock.calls.slice(before).filter(([state]) => state.activity?.[provider] !== undefined)
    expect(saves.length).toBeGreaterThanOrEqual(3)
    expect(saves.length).toBeLessThanOrEqual(4)
    expect(saves.at(-1)?.[0].activity?.[provider]).toBe(epoch + 120_000)
    expect(f.state.activity?.[provider]).toBe(epoch + 179_000)
  })

  it('logs every decision without credentials', async () => {
    const f = await started()
    await f.controller.rebalance(provider, 'new')
    await converse(f, 'new', 'primary', 'b')
    const serialized = JSON.stringify(f.decisions)
    for (const value of f.credentials) {
      if (value.access) expect(serialized).not.toContain(value.access)
      if (value.key) expect(serialized).not.toContain(value.key)
    }
    expect(f.decisions.map(item => item.event)).toEqual(['cache', 'usage', 'usage', 'start', 'switch', 'use'])
    expect(f.decisions.find(item => item.event === 'use')).toMatchObject({ to: 'Synthetic b', reason: 'Session new (model).' })
    expect(f.decisions.filter(item => item.event === 'usage').map(item => [item.from, item.reason])).toEqual([
      ['Synthetic a', '5-hour 20% (resets in 3h 42m) · Weekly 30% (resets in 4d 20h)'],
      ['Synthetic b', '5-hour 20% (resets in 1h 42m) · Weekly 30% (resets in 3d 23h)'],
    ])
    expect(f.decisions.every(item => item.provider === provider && item.at >= epoch)).toBe(true)
  })

  it('uses the cache lifetime OpenCode is configured with (cache.ttl), never shorter than the provider default', async () => {
    const f = await started({ cacheTTL: async () => hours(1) })
    expect(f.controller.cacheWindow(provider)).toEqual({ ms: hours(1), source: 'OpenCode cache.ttl setting (1h 0m)' })
    expect(f.decisions[0]).toMatchObject({ event: 'cache', reason: 'Prompt cache counts as warm for 1h 0m after a conversation request (OpenCode cache.ttl setting (1h 0m)). Smart switches wait that long.' })
    await converse(f)
    f.advance(minutes(59))
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).not.toHaveBeenCalled()
    f.advance(minutes(1))
    await f.controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
    const short = await started({ cacheTTL: async () => minutes(1) })
    expect(short.controller.cacheWindow(provider).ms).toBe(cache)
    const failing = await started({ cacheTTL: async () => { throw new Error('settings unavailable') } })
    expect(failing.controller.cacheWindow(provider)).toEqual({ ms: cache, source: `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} default; OpenCode sends no cache.ttl` })
    const override = await started({ cacheWindowMs: minutes(20), cacheTTL: async () => hours(1) })
    expect(override.controller.cacheWindow(provider)).toEqual({ ms: minutes(20), source: 'cacheWindowMs in the router config' })
  })

  it('logs how each failed request was classified, and why a failover could not happen', async () => {
    const f = fixture(provider, { settings: { allowPaidFallback: false, apiKeyAccountID: undefined, apiKeyModels: [] } })
    await f.controller.initialize(provider)
    const throttle = provider === 'anthropic' ? JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests per minute' } }) : JSON.stringify({ error: { type: 'rate_limit_exceeded' } })
    const { input } = await f.reject('a', { body: throttle, headers: {} })
    input.error.type = 'provider.rate-limit'
    expect(await f.controller.onRetry(input)).toBe(false)
    expect(f.decisions.at(-1)).toMatchObject({ event: 'ignored', level: 'info', from: 'Synthetic a' })
    expect(f.decisions.at(-1)?.reason).toMatch(/temporary rate limit or overload \(HTTP 429.*OpenCode retries on the same account/)
    f.credentials.find(value => value.id === 'b')!.needsAuth = true
    f.accounts.find(value => value.id === 'b')!.needsAuth = true
    f.advance(60_000)
    const quota = await f.reject('a')
    expect(f.decisions.at(-1)).toMatchObject({ event: 'quota', level: 'warn', from: 'Synthetic a' })
    expect(f.decisions.at(-1)?.reason).toContain('allowance is used up (HTTP 429')
    expect(await f.controller.onRetry(quota.input)).toBe(false)
    expect(f.decisions.at(-1)).toMatchObject({ event: 'no-switch', level: 'warn', from: 'Synthetic a' })
    expect(f.decisions.at(-1)?.reason).toBe("Out of allowance and no safe account to move to (Synthetic b: needs sign-in or its token is unavailable; paid fallback is off). The request ends with the provider's error.")
  })

  it('logs a warning when a conversation request cannot be matched to a selected account', async () => {
    const f = await started()
    const unknown = f.request('outside')
    await f.controller.onRequest(scopeFor(f, 'mystery'), unknown)
    expect(f.decisions.at(-1)).toMatchObject({ event: 'use', level: 'warn' })
    expect(f.decisions.at(-1)?.reason).toContain('could not match to a selected account')
    await f.controller.onRequest(scopeFor(f, 'mystery'), f.request('outside'))
    expect(f.decisions.filter(item => item.event === 'use')).toHaveLength(1)
  })

  it('logs failed usage checks as warnings with the next retry time', async () => {
    const f = fixture(provider, { cold: true })
    f.setMonitor(() => new Response('busy', { status: 429, headers: { 'retry-after': '1200' } }))
    await f.controller.initialize(provider)
    const usage = f.decisions.filter(item => item.event === 'usage')
    expect(usage.map(item => item.level)).toEqual(['warn', 'warn'])
    expect(usage[0]?.reason).toMatch(/^usage check was rate-limited by the provider; next try in \d+m$/)
  })

  it('a throwing logger never breaks routing', async () => {
    const f = fixture(provider, { cold: true })
    f.setMonitor(usageBy(f, userCase))
    const controller = new RouterController({ config: f.config, state: f.state, host: { activate: f.activate, readCredentials: f.readCredentials, listAccounts: f.listAccounts }, fetch: f.fetch, now: f.now, log: () => { throw new Error('disk full') } })
    controllers.push(controller)
    await controller.initialize(provider)
    await controller.rebalance(provider, 'new')
    expect(f.activate).toHaveBeenCalledWith(provider, 'b')
  })

  it('failover after a smart switch still works and picks by soonest-expiring allowance', async () => {
    const f = fixture(provider, { cold: true, settings: { accountIDs: ['a', 'b', 'c'], allowPaidFallback: false, apiKeyAccountID: undefined, apiKeyModels: [] } })
    f.setMonitor(usageBy(f, { a: { session: hours(4) }, b: { session: hours(3) }, c: { session: hours(1) } }))
    await f.controller.initialize(provider)
    await converse(f)
    const { input } = await f.reject('a')
    expect(await f.controller.onRetry(input)).toBe(true)
    expect(f.activate.mock.calls.at(-1)).toEqual([provider, 'c'])
    expect(f.decisions.at(-1)).toMatchObject({ event: 'failover', from: 'Synthetic a', to: 'Synthetic c' })
  })
})
