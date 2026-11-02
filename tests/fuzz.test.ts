import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { emptyState, parseConfig } from '../src/config.js'
import { RouterController } from '../src/controller.js'
import type { RetryInput, RequestScope } from '../src/controller.js'
import { chooseInitial } from '../src/policy.js'
import { adapters, readBoundedJson } from '../src/providers/index.js'
import type { Account, ProviderID, RouterHost, StoredCredential, UsageSnapshot } from '../src/types.js'

const now = Date.parse('2026-11-02T12:00:00Z')
const providers: ProviderID[] = ['anthropic', 'openai']
const runs = { numRuns: 400 }

const credential = (provider: ProviderID, id: string): StoredCredential => ({
  id, provider, label: id, method: 'oauth', active: id === 'a', access: `fuzz-${provider}-${id}`, expiresAt: now + 86_400_000,
  ...(provider === 'openai' ? { metadata: { accountID: `ws-${id}` } } : {}),
})

describe('usage parsing never fabricates values from arbitrary upstream JSON', () => {
  it.each(providers)('%s: any body/status yields a bounded snapshot without throwing', async provider => {
    await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.constantFrom(200, 200, 200, 401, 403, 429, 500), async (body, status) => {
      const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(body), { status })
      const result = await adapters[provider].readUsage(credential(provider, 'a'), { now, fetch })
      expect(['ok', 'needs-auth', 'rate-limited', 'unavailable']).toContain(result.status)
      for (const window of result.windows) {
        if (window.usedPercent !== null) expect(window.usedPercent >= 0 && window.usedPercent <= 100).toBe(true)
        if (window.resetsAt !== null) expect(Number.isFinite(window.resetsAt)).toBe(true)
      }
      if (status !== 200) expect(result.windows).toEqual([])
      if (status === 429) expect(result.retryAt! - now).toBeGreaterThanOrEqual(600_000)
    }), runs)
  })

  it.each(providers)('%s: structured, plausible usage payloads always parse into bounded windows', async provider => {
    const pct = fc.oneof(fc.double({ min: -50, max: 150, noNaN: true }), fc.constant(null), fc.constant(100), fc.constant(0))
    const anthropicWindow = fc.option(fc.record({ utilization: pct, resets_at: fc.option(fc.date({ min: new Date(now - 86_400_000), max: new Date(now + 8 * 86_400_000), noInvalidDate: true }).map(date => date.toISOString())) }))
    const openaiWindow = fc.option(fc.record({ used_percent: pct, limit_window_seconds: fc.constantFrom(18_000, 604_800, 3_600), reset_at: fc.option(fc.integer({ min: Math.floor(now / 1000), max: Math.floor(now / 1000) + 8 * 86_400 })) }))
    const body = provider === 'anthropic'
      ? fc.record({ five_hour: anthropicWindow, seven_day: anthropicWindow, seven_day_opus: anthropicWindow })
      : fc.record({ plan_type: fc.constantFrom('pro', 'plus', 'team'), rate_limit: fc.record({ allowed: fc.boolean(), limit_reached: fc.boolean(), primary_window: openaiWindow, secondary_window: openaiWindow }) })
    let parsed = 0
    await fc.assert(fc.asyncProperty(body, async value => {
      const fetch: typeof globalThis.fetch = async () => Response.json(value)
      const result = await adapters[provider].readUsage(credential(provider, 'a'), { now, fetch })
      if (result.status !== 'ok') return
      parsed++
      for (const window of result.windows) {
        if (window.usedPercent !== null) expect(window.usedPercent >= 0 && window.usedPercent <= 100).toBe(true)
        if (window.resetsAt !== null) expect(window.resetsAt).toBeGreaterThan(now - 2 * 86_400_000)
      }
      if (provider === 'openai') expect(result.allowed).toBe(!(value as { rate_limit: { limit_reached: boolean; allowed: boolean } }).rate_limit.limit_reached && (value as { rate_limit: { allowed: boolean } }).rate_limit.allowed)
    }), runs)
    // The generator must actually reach the parsing branches, not only rejections.
    expect(parsed).toBeGreaterThan(runs.numRuns / 4)
  })

  it('bounded JSON reader matches JSON.parse under any chunking and rejects oversize bodies', async () => {
    await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 20 }), async (value, sizes) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      let offset = 0, index = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) { controller.close(); return }
          const size = sizes[index++ % sizes.length]!
          controller.enqueue(bytes.slice(offset, offset + size))
          offset += size
        },
      })
      const parsed = await readBoundedJson(new Response(stream), { maxBytes: 1024 })
      if (bytes.length > 1024) expect(parsed).toBeUndefined()
      else expect(parsed).toEqual(JSON.parse(JSON.stringify(value)))
    }), { numRuns: 300 })
  })
})

describe('quota classification is conservative', () => {
  const benign = fc.array(fc.constantFrom('please', 'try', 'again', 'later', 'server', 'busy', 'overloaded', 'request', 'error', 'temporarily', 'capacity', 'invalid', 'timeout', 'slow', 'down', 'rate', 'limited'), { minLength: 0, maxLength: 12 }).map(words => words.join(' '))
  const type = fc.constantFrom('rate_limit_error', 'overloaded_error', 'api_error', 'invalid_request_error', 'rate_limit_exceeded', 'server_error', 'slow_down', 'turn_rate_limit_exceeded')

  it.each(providers)('%s: generic 4xx/5xx/429 text without explicit allowance exhaustion is never quota', provider => {
    fc.assert(fc.property(benign, type, fc.constantFrom(400, 408, 409, 429, 500, 502, 503, 529), (message, errorType, status) => {
      const body = provider === 'anthropic' ? { type: 'error', error: { type: errorType, message } } : { error: { type: errorType, code: errorType, message } }
      const result = adapters[provider].classify(status, new Headers(), body, now)
      expect(result.kind).not.toBe('quota')
    }), runs)
  })

  it('openai: explicit usage_limit_reached is always account quota with a sane reset', () => {
    fc.assert(fc.property(fc.option(fc.integer({ min: -1e10, max: 1e10 })), fc.option(fc.integer({ min: -100, max: 1e8 })), (resetsAt, resetsIn) => {
      const error: Record<string, unknown> = { type: 'usage_limit_reached', message: 'The usage limit has been reached' }
      if (resetsAt !== null) error.resets_at = resetsAt
      if (resetsIn !== null) error.resets_in_seconds = resetsIn
      const result = adapters.openai.classify(429, new Headers(), { error }, now)
      expect(result).toMatchObject({ kind: 'quota', scope: 'account' })
      if (result.resetAt !== undefined) expect(result.resetAt).toBeGreaterThan(now)
    }), runs)
  })

  it('anthropic: a rejected unified window header is quota regardless of message noise', () => {
    fc.assert(fc.property(benign, fc.constantFrom('5h', '7d'), (message, window) => {
      const headers = new Headers({ [`anthropic-ratelimit-unified-${window}-status`]: 'rejected', [`anthropic-ratelimit-unified-${window}-reset`]: String(now / 1000 + 3600) })
      expect(adapters.anthropic.classify(429, headers, { type: 'error', error: { type: 'rate_limit_error', message } }, now).kind).toBe('quota')
    }), runs)
  })
})

describe('configuration and policy invariants', () => {
  it('configuration parsing accepts or rejects arbitrary input without leaking it', () => {
    fc.assert(fc.property(fc.jsonValue(), value => {
      try { parseConfig(value) } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('Invalid account-router configuration; check provider selections and interval bounds.')
      }
    }), runs)
  })

  it('initial choice is always an eligible selected OAuth account, never a key or unselected account', () => {
    const ids = ['a', 'b', 'c', 'key', 'outside']
    fc.assert(fc.property(
      fc.subarray(['a', 'b', 'c'], { minLength: 1 }),
      fc.uniqueArray(fc.record({ id: fc.constantFrom(...ids), active: fc.boolean(), needsAuth: fc.boolean() }), { maxLength: 6, selector: row => row.id }),
      fc.array(fc.record({ id: fc.constantFrom(...ids), used: fc.option(fc.integer({ min: 0, max: 100 })), allowed: fc.option(fc.boolean()), age: fc.integer({ min: 0, max: 1_200_000 }) }), { maxLength: 6 }),
      (selected, rows, usages) => {
        const accounts: Account[] = rows.map(row => ({ id: row.id, provider: 'anthropic', label: row.id, method: row.id === 'key' ? 'key' : 'oauth', active: row.active, ...(row.needsAuth ? { needsAuth: true } : {}) }))
        const usage: UsageSnapshot[] = usages.map(item => ({ provider: 'anthropic', accountID: item.id, checkedAt: now - item.age, status: 'ok', windows: [{ id: 'w', label: 'w', durationSeconds: 604_800, usedPercent: item.used, resetsAt: now + 1000 }], ...(item.allowed !== null ? { allowed: item.allowed } : {}) }))
        const choice = chooseInitial({ accountIDs: selected, allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['m'] }, accounts, usage, now)
        if (choice.accountID === undefined) return
        const chosen = accounts.find(account => account.id === choice.accountID)
        expect(chosen?.method).toBe('oauth')
        expect(selected).toContain(choice.accountID)
        expect(chosen?.needsAuth).toBeUndefined()
      },
    ), runs)
  })
})

describe('controller under random event interleavings', () => {
  type Event =
    | { type: 'quota'; session: number; account: 'a' | 'b' | 'key' }
    | { type: 'generic'; session: number; account: 'a' | 'b' | 'key' }
    | { type: 'success'; session: number; account: 'a' | 'b' | 'key' }
    | { type: 'external'; account: 'a' | 'b' | 'outside' }
    | { type: 'advance'; ms: number }

  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.record({ type: fc.constant('quota' as const), session: fc.integer({ min: 0, max: 2 }), account: fc.constantFrom('a' as const, 'b' as const, 'key' as const) }),
    fc.record({ type: fc.constant('generic' as const), session: fc.integer({ min: 0, max: 2 }), account: fc.constantFrom('a' as const, 'b' as const, 'key' as const) }),
    fc.record({ type: fc.constant('success' as const), session: fc.integer({ min: 0, max: 2 }), account: fc.constantFrom('a' as const, 'b' as const, 'key' as const) }),
    fc.record({ type: fc.constant('external' as const), account: fc.constantFrom('a' as const, 'b' as const, 'outside' as const) }),
    fc.record({ type: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 7_200_000 }) }),
  )

  it.each(providers)('%s: only selected accounts or an authorized key are ever activated, and never after generic errors', async provider => {
    let switched = 0
    let paidSwitches = 0
    await fc.assert(fc.asyncProperty(fc.array(event, { minLength: 1, maxLength: 25 }), fc.boolean(), async (events, paid) => {
      let clock = now
      const ids = ['a', 'b', 'key', 'outside'] as const
      const values = ids.map(id => id === 'key' ? { id, provider, label: id, method: 'key' as const, active: false, key: `fuzz-key-${provider}` } : credential(provider, id))
      const accounts: Account[] = values.map(({ id, label, method, active }) => ({ id, provider, label, method, active }))
      const activations: string[] = []
      const host: RouterHost = {
        listAccounts: async () => structuredClone(accounts),
        readCredentials: async () => structuredClone(values).map(value => ({ ...value, active: accounts.find(account => account.id === value.id)!.active })),
        activate: async (_provider, id) => {
          // Paying requires recent confirmed exhaustion of every selected subscription.
          if (id === 'key') for (const sub of ['a', 'b']) expect(state.cooldowns[`${provider}:${sub}`]?.until ?? 0).toBeGreaterThan(clock)
          activations.push(id)
          for (const account of accounts) account.active = account.id === id
        },
      }
      const config = parseConfig({ version: 1, providers: { [provider]: { accountIDs: ['a', 'b'], ...(paid ? { allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['model'] } : {}) } } })
      const state = emptyState()
      for (const id of ['a', 'b']) state.usage[`${provider}:${id}`] = { provider, accountID: id, checkedAt: clock, status: 'ok', windows: [] }
      const fetch: typeof globalThis.fetch = async () => new Response('{}', { status: 503 })
      const controller = new RouterController({ config, host, state, now: () => clock, fetch })
      const attempts = new Map<number, number>()
      try {
        for (const item of events) {
          if (item.type === 'advance') { clock += item.ms; continue }
          if (item.type === 'external') { for (const account of accounts) account.active = account.id === item.account; continue }
          const scope: RequestScope = { sessionID: `s${item.session}`, agent: 'build', model: { providerID: provider, id: 'model' }, kind: 'primary' }
          const value = values.find(entry => entry.id === item.account)!
          const headers = new Headers(provider === 'anthropic' && value.method === 'key' ? { 'x-api-key': value.key! } : { authorization: `Bearer ${value.method === 'key' ? value.key : value.access}` })
          if (provider === 'openai' && value.method === 'oauth') headers.set('chatgpt-account-id', `ws-${value.id}`)
          const url = provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : value.method === 'key' ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses'
          const request = new Request(url, { method: 'POST', headers, body: '{}' })
          const body = item.type === 'quota'
            ? provider === 'anthropic' ? JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Weekly usage limit reached' } }) : JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: clock / 1000 + 3600 } })
            : item.type === 'generic' ? JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests' } }) : '{}'
          const responseHeaders = item.type === 'quota' && provider === 'anthropic' ? { 'anthropic-ratelimit-unified-7d-status': 'rejected' } : undefined
          const before = activations.length
          await controller.onRequest(scope, request)
          await controller.onResponse(scope, request, new Response(body, { status: item.type === 'success' ? 200 : 429, ...(responseHeaders ? { headers: responseHeaders } : {}) }))
          if (item.type === 'success') { attempts.delete(item.session); continue }
          const attempt = (attempts.get(item.session) ?? 0) + 1
          attempts.set(item.session, attempt)
          const input: RetryInput = { sessionID: scope.sessionID, agent: 'build', model: scope.model, attempt, error: { type: item.type === 'quota' ? 'provider.quota' : 'provider.rate-limit', message: 'fuzz', status: 429, response: { body } }, decision: { retry: false } }
          const retried = await controller.onRetry(input)
          if (item.type === 'generic') expect(activations.length).toBe(before)
          if (retried) expect(input.decision).toEqual({ retry: true, delay: 0 })
          else expect(input.decision).toEqual({ retry: false })
        }
        for (const id of activations) {
          expect(['a', 'b', 'key']).toContain(id)
          if (id === 'key') expect(paid).toBe(true)
        }
        switched += activations.length
        paidSwitches += activations.filter(id => id === 'key').length
        expect(JSON.stringify(state)).not.toMatch(/fuzz-(anthropic|openai)-|fuzz-key/)
      } finally { controller.stop() }
    }), { numRuns: 300 })
    // Guard against a vacuous property: random runs must actually exercise switching and paid fallback.
    expect(switched).toBeGreaterThan(20)
    expect(paidSwitches).toBeGreaterThan(0)
  })
})
