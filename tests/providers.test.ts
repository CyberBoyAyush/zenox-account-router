import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fetch, ProviderAdapter, StoredCredential } from '../src/types.js'
import { adapters, anthropicAdapter, checkRetryAfter, openaiAdapter, readBoundedJson } from '../src/providers/index.js'

const now = Date.parse('2026-11-01T10:00:00Z')
const reset = '2026-11-01T15:00:00Z'
const resetSeconds = Date.parse(reset) / 1000
const credential = (provider: 'anthropic' | 'openai', overrides: Partial<StoredCredential> = {}): StoredCredential => ({
  id: 'account-1', provider, label: 'Synthetic', method: 'oauth', active: true, access: 'synthetic-access', ...overrides,
})
const jsonFetch = (body: unknown, status = 200, headers: HeadersInit = {}) => vi.fn<Fetch>(async () => new Response(JSON.stringify(body), { status, headers }))
const read = (adapter: ProviderAdapter, body: unknown, overrides: Partial<StoredCredential> = {}) => adapter.readUsage(credential(adapter.id, overrides), { now, fetch: jsonFetch(body) })
const whamWindow = (duration: number, used = 25) => ({ used_percent: used, limit_window_seconds: duration, reset_at: resetSeconds })
const wham = (overrides: Record<string, unknown> = {}) => ({ plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false, primary_window: whamWindow(18_000), secondary_window: whamWindow(604_800) }, ...overrides })
const anthropic = { five_hour: { utilization: 42, resets_at: reset }, seven_day: { utilization: 80, resets_at: reset } }
const request = (url: string, headers: HeadersInit = { Authorization: 'Bearer synthetic-access' }) => new Request(url, { headers })
const jwt = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`

afterEach(() => { vi.useRealTimers() })

describe('monitoring transport', () => {
  it('exports the complete provider map', () => {
    expect(adapters).toEqual({ anthropic: anthropicAdapter, openai: openaiAdapter })
  })

  it.each([anthropicAdapter, openaiAdapter])('$id never monitors paid API keys, expired tokens or missing auth', async adapter => {
    const fetch = jsonFetch({})
    for (const [overrides, status] of [
      [{ method: 'key', key: 'paid-key' }, 'unsupported'],
      [{ expiresAt: now }, 'expired'],
      [{ expiresAt: now - 1 }, 'expired'],
      [{ access: '' }, 'needs-auth'],
      [{ access: 'unsafe\nheader' }, 'needs-auth'],
      [{ needsAuth: true }, 'needs-auth'],
    ] as const) {
      expect((await adapter.readUsage(credential(adapter.id, overrides), { now, fetch })).status).toBe(status)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([anthropicAdapter, openaiAdapter])('$id uses only fixed GET origins and disables redirects/cookies', async adapter => {
    const fetch = jsonFetch(adapter.id === 'anthropic' ? anthropic : wham())
    await adapter.readUsage(credential(adapter.id), { now, fetch })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(adapter.id === 'anthropic' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer synthetic-access')
    expect(headers.get('accept')).toBe('application/json')
    if (adapter.id === 'anthropic') expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    else expect(headers.get('user-agent')).toBe('zenox-account-router')
  })

  it.each([anthropicAdapter, openaiAdapter])('$id sanitizes thrown failures and malformed payloads', async adapter => {
    const fetch = vi.fn<Fetch>(async () => { throw new Error('synthetic-access credential secret') })
    const result = await adapter.readUsage(credential(adapter.id), { now, fetch })
    expect(result.status).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('synthetic-access')
    for (const body of [null, [], 'invalid', {}, { unexpected: true }]) expect((await read(adapter, body)).status).toBe('unavailable')
  })

  it.each([anthropicAdapter, openaiAdapter])('$id treats monitoring 429 only as polling backoff', async adapter => {
    const fetch = jsonFetch({ error: { type: 'usage_limit_reached' } }, 429)
    const result = await adapter.readUsage(credential(adapter.id), { now, fetch })
    expect(result).toMatchObject({ status: 'rate-limited', retryAt: now + 600_000, windows: [] })
    expect(result.allowed).toBeUndefined()
    for (const status of [401, 403]) expect((await adapter.readUsage(credential(adapter.id), { now, fetch: jsonFetch({}, status) })).status).toBe('needs-auth')
  })

  it('honors Retry-After with a ten-minute minimum and 24-hour ceiling', () => {
    for (const [value, delay] of [['2', 600_000], ['3600', 3_600_000], ['999999999', 86_400_000], ['invalid', 600_000], ['-42', 600_000], [new Date(now + 7_200_000).toUTCString(), 7_200_000]] as const) {
      expect(checkRetryAfter(new Headers({ 'retry-after': value }), now)).toBe(now + delay)
    }
  })

  it('aborts a hanging fetch after ten seconds even when fetch ignores signals', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<Fetch>(() => new Promise(() => undefined))
    const pending = anthropicAdapter.readUsage(credential('anthropic'), { now, fetch })
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await pending).status).toBe('unavailable')
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('honors caller abort without waiting for an uncooperative fetch', async () => {
    const controller = new AbortController()
    const pending = openaiAdapter.readUsage(credential('openai'), { now, fetch: () => new Promise(() => undefined), signal: controller.signal })
    controller.abort()
    expect((await pending).status).toBe('unavailable')
  })
})

describe('bounded JSON', () => {
  it('reads JSON and rejects malformed UTF-8/JSON', async () => {
    expect(await readBoundedJson(new Response('{"ok":true}'))).toEqual({ ok: true })
    expect(await readBoundedJson(new Response('{'))).toBeUndefined()
    expect(await readBoundedJson(new Response(new Uint8Array([255])))).toBeUndefined()
  })

  it('cancels oversize streams without consuming an unbounded body', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)) }, cancel,
    }))
    expect(await readBoundedJson(response)).toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('enforces byte limits (not decoded character counts)', async () => {
    expect(await readBoundedJson(new Response('"😀"'), { maxBytes: 5 })).toBeUndefined()
    expect(await readBoundedJson(new Response('"😀"'), { maxBytes: 6 })).toBe('😀')
  })

  it('times out and cancels a body that never completes without awaiting cancel', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    const pending = readBoundedJson(response, { timeoutMs: 30 })
    await vi.advanceTimersByTimeAsync(30)
    expect(await pending).toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('Anthropic usage', () => {
  it('parses ordinary and explicitly scoped windows, never extra-usage billing', async () => {
    const result = await read(anthropicAdapter, { ...anthropic, seven_day_opus: { utilization: 100, resets_at: reset }, extra_usage: { utilization: 99 } })
    expect(result.status).toBe('ok')
    expect(result.windows).toHaveLength(3)
    expect(result.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 42, resetsAt: Date.parse(reset), durationSeconds: 18_000 })
    expect(result.windows[2]).toMatchObject({ model: 'opus', usedPercent: 100 })
    expect(result.allowed).toBeUndefined()
  })

  it('keeps null windows unknown and preserves explicitly reported zero without a reset', async () => {
    const result = await read(anthropicAdapter, { five_hour: null, seven_day: { utilization: 0, resets_at: null } })
    expect(result.windows.find(window => window.id === 'five_hour')?.usedPercent).toBeNull()
    expect(result.windows.find(window => window.id === 'seven_day')?.usedPercent).toBe(0)
    expect(result.windows.every(window => window.resetsAt === null)).toBe(true)
    expect((await read(anthropicAdapter, { five_hour: { resets_at: reset } })).windows[0]?.usedPercent).toBeNull()
  })

  it.each([{ five_hour: [] }, { five_hour: { utilization: '0' } }, { five_hour: { utilization: 101 } }, { five_hour: { resets_at: 123 } }, { five_hour: { resets_at: 'not-a-date' } }])('rejects malformed ordinary fields: %j', async body => {
    expect((await read(anthropicAdapter, body)).status).toBe('unavailable')
  })
})

describe('OpenAI usage and workspace safety', () => {
  it('trusts allowed=true over displayed 100% and classifies swapped windows by duration', async () => {
    const result = await read(openaiAdapter, wham({ rate_limit: { allowed: true, limit_reached: false, primary_window: whamWindow(604_800, 100), secondary_window: whamWindow(18_000, 100) } }))
    expect(result.allowed).toBe(true)
    expect(result.windows.map(window => window.id)).toEqual(['seven_day', 'five_hour'])
  })

  it('preserves generic windows and null percentages; body flags gate authoritatively', async () => {
    const result = await read(openaiAdapter, wham({ rate_limit: { limit_reached: true, primary_window: { used_percent: null, reset_at: null, limit_window_seconds: 1234 } } }))
    expect(result.allowed).toBe(false)
    expect(result.windows[0]).toMatchObject({ id: 'primary', usedPercent: null, resetsAt: null })
    const unknown = await read(openaiAdapter, wham({ rate_limit: { primary_window: whamWindow(18_000, 100) } }))
    expect(unknown.allowed).toBeUndefined()
    expect((await read(openaiAdapter, wham({ rate_limit: { allowed: false } }))).allowed).toBe(false)
  })

  it('uses relative reset seconds only when an absolute window reset is absent', async () => {
    const result = await read(openaiAdapter, wham({ rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 90 }, secondary_window: { used_percent: 30, reset_at: resetSeconds, reset_after_seconds: 1 } } }))
    expect(result.windows[0]?.resetsAt).toBe(now + 90_000)
    expect(result.windows[1]?.resetsAt).toBe(resetSeconds * 1000)
  })

  it('caps additional limits at eight and requires an identifiable model scope', async () => {
    const extra = Array.from({ length: 12 }, (_, index) => ({ limit_name: `gpt-5-codex-${index}`, rate_limit: { allowed: false, primary_window: whamWindow(18_000) } }))
    const result = await read(openaiAdapter, wham({ additional_rate_limits: extra }))
    expect(result.windows).toHaveLength(10)
    expect(result.allowed).toBe(true)
    expect(result.windows[2]?.model).toBe('gpt-5-codex-0')
    expect((await read(openaiAdapter, wham({ additional_rate_limits: [{ limit_name: 'subscription', rate_limit: { primary_window: whamWindow(18_000) } }] }))).windows).toHaveLength(2)
  })

  it.each([{ allowed: 'true' }, { limit_reached: 0 }, { primary_window: {} , allowed: 'no' }, { primary_window: { used_percent: '99' } }, { primary_window: { reset_at: 'tomorrow' } }, { primary_window: { limit_window_seconds: -1 } }])('rejects malformed rate_limit: %j', async rate_limit => {
    expect((await read(openaiAdapter, { rate_limit })).status).toBe('unavailable')
  })

  it('prefers OpenCode accountID over aliases and JWT payload; does not infer organizations', async () => {
    for (const metadata of [{ accountID: 'preferred', account_id: 'fallback' }, { account_id: 'preferred' }, { chatgpt_account_id: 'preferred' }]) {
      const fetch = jsonFetch(wham())
      await openaiAdapter.readUsage(credential('openai', { metadata, access: jwt({ chatgpt_account_id: 'jwt-workspace' }) }), { now, fetch })
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('ChatGPT-Account-Id')).toBe('preferred')
    }
    for (const payload of [{ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-workspace' } }, { chatgpt_account_id: 'jwt-workspace' }, { organizations: [{ id: 'wrong' }] }]) {
      const fetch = jsonFetch(wham())
      await openaiAdapter.readUsage(credential('openai', { access: jwt(payload) }), { now, fetch })
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('ChatGPT-Account-Id')).toBe('organizations' in payload ? null : 'jwt-workspace')
    }
  })

  it.each(['bad workspace', 'bad\tworkspace', 'bad\nworkspace', 'bad\rworkspace', '☃', ''])('rejects unsafe account metadata: %j', async accountID => {
    const fetch = jsonFetch(wham())
    const result = await openaiAdapter.readUsage(credential('openai', { metadata: { accountID } }), { now, fetch })
    expect(result.status).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(openaiAdapter.matchesRequest(credential('openai', { metadata: { accountID } }), request('https://api.openai.com/v1/responses'))).toBe(false)
  })

  it('does not emit a FedRAMP hint or trust JWT verification claims implicitly', async () => {
    const fetch = jsonFetch(wham())
    await openaiAdapter.readUsage(credential('openai', { access: jwt({ chatgpt_account_id: 'bounded-id', organizations: [{ is_fedramp: true }] }) }), { now, fetch })
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect([...headers.keys()].some(header => header.includes('fedramp'))).toBe(false)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    const huge = jwt({ chatgpt_account_id: 'not-used', padding: 'a'.repeat(20_000) })
    expect(openaiAdapter.matchesRequest(credential('openai', { access: huge }), request('https://api.openai.com/v1/responses', { Authorization: `Bearer ${huge}` }))).toBe(false)
  })

  it('includes FedRAMP query hints only for explicit booleans, not plans or organizations', async () => {
    for (const hint of [true, false]) {
      const fetch = jsonFetch(wham())
      await openaiAdapter.readUsage(credential('openai', { access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_is_fedramp: hint } }) }), { now, fetch })
      expect(fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-OpenAI-Fedramp')).toBe(hint ? 'true' : null)
    }
    const fetch = jsonFetch(wham())
    await openaiAdapter.readUsage(credential('openai', { metadata: { is_fedramp: 'true', plan: 'enterprise' } }), { now, fetch })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
  })
})

describe('trusted request matching', () => {
  it('requires exact Anthropic auth at the fixed inference origin', () => {
    const account = credential('anthropic')
    expect(anthropicAdapter.matchesRequest(account, request('https://api.anthropic.com/v1/messages'))).toBe(true)
    for (const url of ['https://api.anthropic.com.evil.test/v1/messages', 'https://evil.test/v1/messages', 'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com:444/v1/messages', 'https://api.anthropic.com/api/oauth/usage']) expect(anthropicAdapter.matchesRequest(account, request(url))).toBe(false)
    expect(anthropicAdapter.matchesRequest(account, request('https://api.anthropic.com/v1/messages', { Authorization: 'Bearer other' }))).toBe(false)
    const key = credential('anthropic', { method: 'key', key: 'paid-key' })
    expect(anthropicAdapter.matchesRequest(key, request('https://api.anthropic.com/v1/messages', { 'x-api-key': 'paid-key' }))).toBe(true)
    expect(anthropicAdapter.matchesRequest(key, request('https://api.anthropic.com/v1/messages', { Authorization: 'Bearer paid-key' }))).toBe(false)
  })

  it('requires exact OpenAI origins, inference paths, bearer and OAuth workspace', () => {
    const account = credential('openai', { metadata: { accountID: 'workspace-a' } })
    const headers = { Authorization: 'Bearer synthetic-access', 'ChatGPT-Account-Id': 'workspace-a' }
    for (const url of ['https://api.openai.com/v1/responses', 'https://chatgpt.com/backend-api/codex/responses']) expect(openaiAdapter.matchesRequest(account, request(url, headers))).toBe(true)
    for (const url of ['https://api.openai.com.evil.test/v1/responses', 'https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/codex/responses/evil', 'https://api.openai.com/v10/responses', 'http://api.openai.com/v1/responses']) expect(openaiAdapter.matchesRequest(account, request(url, headers))).toBe(false)
    const withCredentials = request('https://api.openai.com/v1/responses', headers)
    Object.defineProperty(withCredentials, 'url', { value: 'https://user:pass@api.openai.com/v1/responses' })
    expect(openaiAdapter.matchesRequest(account, withCredentials)).toBe(false)
    expect(openaiAdapter.matchesRequest(account, request('https://api.openai.com/v1/responses'))).toBe(false)
    expect(openaiAdapter.matchesRequest(account, request('https://api.openai.com/v1/responses', { ...headers, 'ChatGPT-Account-Id': 'workspace-b' }))).toBe(false)
    expect(openaiAdapter.matchesRequest(credential('openai', { method: 'key', key: 'paid-key', metadata: { accountID: 'irrelevant' } }), request('https://api.openai.com/v1/responses', { Authorization: 'Bearer paid-key' }))).toBe(true)
  })

  it.each([anthropicAdapter, openaiAdapter])('$id rejects empty auth even if a header is present', adapter => {
    const url = adapter.id === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses'
    expect(adapter.matchesRequest(credential(adapter.id, { access: '' }), request(url, { Authorization: 'Bearer ' }))).toBe(false)
  })
})

describe('inference classification', () => {
  it.each([anthropicAdapter, openaiAdapter])('$id never treats HTTP auth failures as quota', adapter => {
    for (const status of [401, 403]) expect(adapter.classify(status, new Headers(), { error: { type: 'usage_limit_reached', message: 'Weekly usage limit reached' } }, now).kind).toBe('auth')
    expect(adapter.classify(429, new Headers(), {}, now).kind).toBe('transient')
  })

  it('uses only explicitly rejected Anthropic windows, with the maximum rejected reset', () => {
    const headers = new Headers({ 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(resetSeconds), 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-reset': String(resetSeconds + 99999) })
    expect(anthropicAdapter.classify(429, headers, {}, now)).toMatchObject({ kind: 'quota', resetAt: Date.parse(reset) })
    headers.set('anthropic-ratelimit-unified-7d-status', 'rejected')
    expect(anthropicAdapter.classify(429, headers, {}, now).resetAt).toBe((resetSeconds + 99999) * 1000)
    expect(anthropicAdapter.classify(429, new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }), {}, now).kind).toBe('transient')
  })

  it.each(['Weekly usage limit reached', 'Your session allowance has been exhausted', 'You have exceeded your subscription usage limit', 'Plan quota exceeded', 'You have reached your Claude usage limit'])('recognizes explicit Anthropic allowance: %s', message => {
    expect(anthropicAdapter.classify(429, new Headers(), { error: { message } }, now).kind).toBe('quota')
  })

  it.each(['Extra usage limit reached', 'Long context weekly usage limit reached', 'Fast mode subscription limit reached', 'You have reached your Claude usage limit for Opus', 'Model-specific usage limit reached'])('keeps model restrictions out of account quota: %s', message => {
    expect(anthropicAdapter.classify(429, new Headers(), { error: { message } }, now)).toMatchObject({ kind: 'model-restriction', scope: 'model' })
  })

  it('treats an Anthropic key with an empty credit balance as account exhaustion', () => {
    const message = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
    expect(anthropicAdapter.classify(400, new Headers(), { type: 'error', error: { type: 'invalid_request_error', message } }, now)).toEqual({ kind: 'quota', scope: 'account', code: 'credit_balance' })
    expect(anthropicAdapter.classify(402, new Headers(), { type: 'error', error: { type: 'billing_error', message: 'Payment required' } }, now)).toEqual({ kind: 'quota', scope: 'account', code: 'credit_balance' })
    expect(anthropicAdapter.classify(400, new Headers(), { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }, now).kind).toBe('unknown')
    expect(anthropicAdapter.classify(429, new Headers(), { error: { message: 'Extra usage credit balance is too low for long context' } }, now)).toMatchObject({ kind: 'model-restriction', scope: 'model' })
  })

  it.each(['Too many requests', 'Tokens per minute limit exceeded', 'RPM limit reached', 'Please retry later'])('does not mistake transient Anthropic errors for quota: %s', message => {
    expect(anthropicAdapter.classify(429, new Headers(), { error: { message } }, now).kind).toBe('transient')
    expect(anthropicAdapter.classify(500, new Headers(), { error: { message: 'Weekly usage limit reached' } }, now).kind).toBe('unknown')
  })

  it('classifies OpenAI documented codes in nested, top-level and wrapped errors without depending on HTTP429', () => {
    for (const body of [{ error: { type: 'usage_limit_reached', resets_at: resetSeconds } }, { type: 'usage_limit_reached', resets_at: resetSeconds }, { body: { error: { type: 'usage_limit_reached', resets_at: resetSeconds } } }]) expect(openaiAdapter.classify(400, new Headers(), body, now)).toMatchObject({ kind: 'quota', scope: 'account', resetAt: Date.parse(reset) })
    expect(openaiAdapter.classify(429, new Headers(), { error: { type: 'usage_limit_reached', resets_in_seconds: 42 } }, now).resetAt).toBe(now + 42_000)
    expect(openaiAdapter.classify(429, new Headers(), { error: { type: 'usage_limit_reached', resets_at: 'secret', resets_in_seconds: -1 } }, now).resetAt).toBeUndefined()
  })

  it('separates billing quota, model restrictions, transient and unknown OpenAI fields', () => {
    expect(openaiAdapter.classify(400, new Headers(), { error: { code: 'insufficient_quota' } }, now)).toMatchObject({ kind: 'quota', scope: 'account' })
    expect(openaiAdapter.classify(400, new Headers(), { error: { type: 'usage_not_included' } }, now)).toMatchObject({ kind: 'model-restriction', scope: 'model' })
    for (const type of ['turn_rate_limit_exceeded', 'rate_limit_exceeded', 'slow_down']) expect(openaiAdapter.classify(400, new Headers(), { error: { type } }, now).kind).toBe('transient')
    expect(openaiAdapter.classify(400, new Headers(), { error: { type: 'new_unknown_error', message: 'usage_limit_reached' } }, now).kind).toBe('unknown')
    expect(openaiAdapter.classify(400, new Headers(), { quota: true }, now).kind).toBe('unknown')
  })
})
