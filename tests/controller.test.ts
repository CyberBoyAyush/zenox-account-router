import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState, parseConfig } from '../src/config.js'
import { RouterController } from '../src/controller.js'
import type { RequestScope, RetryInput } from '../src/controller.js'
import type { Account, Fetch, ProviderConfig, ProviderID, RouterHost, RouterState, StoredCredential, UsageSnapshot } from '../src/types.js'

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

function fixture(provider: ProviderID, options: { settings?: Partial<ProviderConfig>; state?: RouterState; cold?: boolean; idleTimeoutMs?: number; pollIntervalMs?: number } = {}) {
  let now = epoch
  const settings: ProviderConfig = { accountIDs: ['a', 'b'], allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['model'], ...options.settings }
  const config = parseConfig({ version: 1, pollIntervalMs: options.pollIntervalMs ?? interval, idleTimeoutMs: options.idleTimeoutMs ?? interval, providers: { [provider]: settings } })
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
  const controller = new RouterController({ config, state, host: { activate, readCredentials, listAccounts }, fetch, now: () => now, persist })
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
  return { provider, config, settings, state, accounts, credentials, controller, fetch, activate, persist, readCredentials, listAccounts, scope, request, retry, reject, now: () => now, advance: (milliseconds: number) => { now += milliseconds }, setMonitor: (value: typeof monitor) => { monitor = value }, setActive: (id: string) => { for (const account of accounts) account.active = account.id === id } }
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
    expect(f.persist.mock.calls.every(([state]) => Object.keys(state).sort().join(',') === 'cooldowns,sticky,usage,version')).toBe(true)
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
