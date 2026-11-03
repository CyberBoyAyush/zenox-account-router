import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RouterRpc } from '../../src/rpc.js'
import type { ProviderID } from '../../src/types.js'
import { blockedSockets, key, MODELS, modelRestriction, oauth, start, success, transient, usage, weeklyQuota } from './harness.js'
import type { Harness } from './harness.js'

let harness: Harness | undefined
let expectedRefreshes = 0
afterEach(async () => {
  try {
    if (harness) {
      // Every test must stay inside the fake provider surface and refresh only when it intends to.
      expect(harness.unexpected().map(call => call.url)).toEqual([])
      expect(harness.calls.filter(call => call.kind === 'refresh')).toHaveLength(expectedRefreshes)
    }
    expect(blockedSockets).toEqual([])
  } finally {
    await harness?.close()
    harness = undefined
    expectedRefreshes = 0
  }
})

const bearer = (id: string): string => `Bearer access-${id}`
const providers: ProviderID[] = ['anthropic', 'openai']

describe.each(providers)('%s through real OpenCode core', provider => {
  const accounts = () => [oauth(provider, 'cred_b'), oauth(provider, 'cred_a')]
  const quotaFor = (token: string) => (call: Parameters<Parameters<Harness['respond']>[0]>[0]) => call.kind === 'inference' && call.primary && call.authorization === bearer(token) ? weeklyQuota(provider) : undefined

  it('keeps a healthy active account and monitors each selected account once', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    const first = await harness.run(provider)
    const second = await harness.run(provider, 'again', first.sessionID)
    expect(first.text).toBe('fake success')
    expect(second.text).toBe('fake success')
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual([bearer('cred_a'), bearer('cred_a')])
    expect(harness.calls.filter(call => call.kind === 'usage').map(call => call.authorization).sort()).toEqual([bearer('cred_a'), bearer('cred_b')])
    expect(await harness.active(provider)).toBe('cred_a')
    const state = await harness.state()
    expect(state.usage[`${provider}:cred_a`]?.status).toBe('ok')
    expect(JSON.stringify(state)).not.toMatch(/access-|refresh-|sk-synthetic/)
    // The status RPC behind /router-status, called through real OpenCode routing.
    const status = await harness.sdk.rpc(RouterRpc).status({}, { location: harness.location }) as { text: string; report: { providers: { accounts: { id: string; active: boolean }[] }[] } }
    expect(status.report.providers[0]!.accounts.map(account => [account.id, account.active])).toEqual([['cred_a', true], ['cred_b', false]])
    expect(status.text).toMatch(/● Synthetic cred_a\s+ACTIVE\n/)
    expect(status.text).toMatch(/Weekly\s+█+░+\s+10%\s+resets in/)
    expect(status.text).not.toMatch(/access-|refresh-/)
  }, 60_000)

  it('fails over A → B on confirmed quota exhaustion, then stays on B', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    harness.respond(quotaFor('cred_a'))
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    const primaries = harness.primaries(provider)
    expect(primaries.map(call => call.authorization)).toEqual([bearer('cred_a'), bearer('cred_b')])
    if (provider === 'openai') expect(primaries.map(call => call.workspace)).toEqual(['ws-cred_a', 'ws-cred_b'])
    expect(await harness.active(provider)).toBe('cred_b')
    expect((await harness.state()).cooldowns[`${provider}:cred_a`]).toBeDefined()
    harness.respond(() => undefined)
    const next = await harness.run(provider, 'still sticky', result.sessionID)
    expect(next.text).toBe('fake success')
    expect(harness.primaries(provider).at(-1)?.authorization).toBe(bearer('cred_b'))
    // The log tells the whole story: A used, A rejected for quota, failover to B, the session now on B.
    const engine = harness
    const logPath = join(dirname(engine.statePath), 'account-router.log')
    await expect.poll(async () => readFile(logPath, 'utf8')).toMatch(/\| FAILOVER \|/)
    const log = (await readFile(logPath, 'utf8')).split('\n').map(line => line.split(' | ').slice(1, 5).join(' | '))
    const story = log.filter(line => / \| (?:USE|QUOTA|FAILOVER) \| /.test(line))
    expect(story).toEqual([
      `INFO  | ${provider} | USE | Synthetic cred_a`,
      `WARN  | ${provider} | QUOTA | Synthetic cred_a`,
      `INFO  | ${provider} | FAILOVER | Synthetic cred_a → Synthetic cred_b`,
      `INFO  | ${provider} | USE | Synthetic cred_b`,
    ])
  }, 60_000)

  it('does not switch accounts on a temporary rate limit', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    let sent = false
    harness.respond(call => call.kind === 'inference' && call.primary && !sent ? (sent = true, transient(provider)) : undefined)
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual([bearer('cred_a'), bearer('cred_a')])
    expect(await harness.active(provider)).toBe('cred_a')
    expect((await harness.state()).cooldowns).toEqual({})
  }, 60_000)

  it('does not switch accounts on a model/plan restriction', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    harness.respond(call => call.kind === 'inference' && call.primary ? modelRestriction(provider) : undefined)
    const result = await harness.run(provider)
    expect(result.failed).toBe(true)
    expect(new Set(harness.primaries(provider).map(call => call.authorization))).toEqual(new Set([bearer('cred_a')]))
    expect(await harness.active(provider)).toBe('cred_a')
  }, 60_000)

  it('does not switch when only an auxiliary title request hits quota', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    harness.respond(call => call.kind === 'inference' && !call.primary ? weeklyQuota(provider) : undefined)
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    expect(harness.calls.some(call => call.kind === 'inference' && !call.primary && call.model !== MODELS[provider])).toBe(true)
    expect(await harness.active(provider)).toBe('cred_a')
    expect((await harness.state()).cooldowns).toEqual({})
  }, 60_000)

  it('uses the paid key only after every subscription is exhausted and the model is allowlisted', async () => {
    harness = await start({
      router: { [provider]: { accountIDs: ['cred_a', 'cred_b'], apiKeyAccountID: 'cred_key', allowPaidFallback: true, apiKeyModels: [MODELS[provider]] } },
      credentials: { [provider]: [key('cred_key'), ...accounts()] },
    })
    harness.respond(call => call.kind === 'inference' && call.primary && (call.authorization === bearer('cred_a') || call.authorization === bearer('cred_b')) ? weeklyQuota(provider) : undefined)
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    const primaries = harness.primaries(provider)
    expect(primaries.slice(0, 2).map(call => call.authorization)).toEqual([bearer('cred_a'), bearer('cred_b')])
    const paid = primaries.at(-1)!
    if (provider === 'anthropic') {
      expect(paid.apiKey).toBe('sk-synthetic-cred_key')
      expect(paid.authorization).toBeNull()
    } else {
      expect(paid.url).toBe('https://api.openai.com/v1/responses')
      expect(paid.authorization).toBe('Bearer sk-synthetic-cred_key')
      expect(paid.workspace).toBeNull()
    }
    expect(await harness.active(provider)).toBe('cred_key')
  }, 60_000)

  it('stops with an error instead of paying when paid fallback is not authorized', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [key('cred_key'), ...accounts()] } })
    harness.respond(call => call.kind === 'inference' && call.primary && call.authorization?.startsWith('Bearer access-') ? weeklyQuota(provider) : undefined)
    const result = await harness.run(provider)
    expect(result.failed).toBe(true)
    expect(harness.primaries(provider).every(call => call.authorization !== 'Bearer sk-synthetic-cred_key' && call.apiKey === null)).toBe(true)
    expect(await harness.active(provider)).toBe('cred_b')
  }, 60_000)

  it('leaves an active paid key for a usable subscription before the next prompt is sent', async () => {
    harness = await start({
      router: { [provider]: { accountIDs: ['cred_a', 'cred_b'], apiKeyAccountID: 'cred_key', allowPaidFallback: true, apiKeyModels: [MODELS[provider]] } },
      credentials: { [provider]: [...accounts(), key('cred_key')] },
    })
    expect(await harness.active(provider)).toBe('cred_key')
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    const primaries = harness.primaries(provider)
    expect(primaries.map(call => call.authorization)).toEqual([bearer('cred_a')])
    if (provider === 'openai') expect(primaries.map(call => call.workspace)).toEqual(['ws-cred_a'])
    expect(primaries.every(call => call.apiKey === null)).toBe(true)
    expect(await harness.active(provider)).toBe('cred_a')
  }, 60_000)

  it('stays on the paid key while every subscription is reported exhausted', async () => {
    harness = await start({
      router: { [provider]: { accountIDs: ['cred_a', 'cred_b'], apiKeyAccountID: 'cred_key', allowPaidFallback: true, apiKeyModels: [MODELS[provider]] } },
      credentials: { [provider]: [...accounts(), key('cred_key')] },
    })
    harness.respond(call => call.kind === 'usage' ? usage(provider, 100) : undefined)
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    expect(harness.primaries(provider).every(call => !call.authorization?.startsWith('Bearer access-'))).toBe(true)
    expect(await harness.active(provider)).toBe('cred_key')
  }, 60_000)

  it('does not take over when the active account is outside the selected set', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [...accounts(), oauth(provider, 'cred_manual')] } })
    harness.respond(quotaFor('cred_manual'))
    const result = await harness.run(provider)
    expect(result.failed).toBe(true)
    expect(await harness.active(provider)).toBe('cred_manual')
    expect(harness.primaries(provider).every(call => call.authorization === bearer('cred_manual'))).toBe(true)
  }, 60_000)

  it('switches once when two sessions hit quota concurrently', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: accounts() } })
    harness.respond(quotaFor('cred_a'))
    const results = await Promise.all([harness.run(provider, 'one'), harness.run(provider, 'two')])
    expect(results.map(result => result.text)).toEqual(['fake success', 'fake success'])
    expect(await harness.active(provider)).toBe('cred_b')
    const successes = harness.primaries(provider).filter(call => call.authorization === bearer('cred_b'))
    expect(successes.length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})

describe('anthropic empty credit balance through real OpenCode core', () => {
  const credit = (): Response => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }, { status: 400 })

  it('routes the non-retryable 400 through the retry hook and moves to a usable account', async () => {
    harness = await start({ router: { anthropic: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { anthropic: [oauth('anthropic', 'cred_b'), oauth('anthropic', 'cred_a')] } })
    harness.respond(call => call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a') ? credit() : undefined)
    const result = await harness.run('anthropic')
    expect(result.text).toBe('fake success')
    expect(harness.primaries('anthropic').map(call => call.authorization)).toEqual([bearer('cred_a'), bearer('cred_b')])
    expect(await harness.active('anthropic')).toBe('cred_b')
  }, 60_000)

  it('stops with the error when the empty key has no usable subscription to return to', async () => {
    harness = await start({
      router: { anthropic: { accountIDs: ['cred_a', 'cred_b'], apiKeyAccountID: 'cred_key', allowPaidFallback: true, apiKeyModels: [MODELS.anthropic] } },
      credentials: { anthropic: [oauth('anthropic', 'cred_b'), oauth('anthropic', 'cred_a'), key('cred_key')] },
    })
    harness.respond(call => call.kind === 'usage' ? usage('anthropic', 100) : call.kind === 'inference' && call.primary && call.apiKey ? credit() : undefined)
    const result = await harness.run('anthropic')
    expect(result.failed).toBe(true)
    expect(harness.primaries('anthropic').every(call => call.apiKey === 'sk-synthetic-cred_key')).toBe(true)
    expect(await harness.active('anthropic')).toBe('cred_key')
  }, 60_000)
})

describe('owner-managed refresh and broken backups', () => {
  it('openai: OpenCode refreshes an expired idle backup through its owner, then fails over to it with its workspace', async () => {
    expectedRefreshes = 1
    harness = await start({ router: { openai: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { openai: [oauth('openai', 'cred_a'), { ...oauth('openai', 'cred_b', { expires: Date.now() - 60_000 }), inactive: true }] } })
    harness.respond(call => {
      // Real ChatGPT refresh responses carry an id_token whose claims hold the workspace id.
      const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws-cred_b' } })).toString('base64url')
      if (call.kind === 'refresh') return Response.json({ access_token: 'access-cred_b-refreshed', refresh_token: 'refresh-cred_b-2', id_token: `e30.${claims}.synthetic`, expires_in: 28_800 })
      if (call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a')) return weeklyQuota('openai')
      return undefined
    })
    const result = await harness.run('openai')
    expect(result.text).toBe('fake success')
    const last = harness.primaries('openai').at(-1)!
    expect(last.authorization).toBe('Bearer access-cred_b-refreshed')
    expect(last.workspace).toBe('ws-cred_b')
    expect(await harness.active('openai')).toBe('cred_b')
  }, 60_000)

  it.each(providers)('%s: a backup whose refresh keeps failing is refreshed at most once across many prompts and never used', async provider => {
    expectedRefreshes = 1
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [oauth(provider, 'cred_a'), { ...oauth(provider, 'cred_b', { expires: Date.now() - 60_000 }), inactive: true }] } })
    harness.respond(call => call.kind === 'refresh' ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : undefined)
    let session: string | undefined
    for (let index = 0; index < 5; index++) session = (await harness.run(provider, `turn ${index}`, session)).sessionID
    harness.respond(call => {
      if (call.kind === 'refresh') return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a') ? weeklyQuota(provider) : undefined
    })
    const result = await harness.run(provider, 'quota now', session)
    expect(result.failed).toBe(true)
    expect(await harness.active(provider)).toBe('cred_a')
    expect(harness.primaries(provider).every(call => call.authorization === bearer('cred_a'))).toBe(true)
  }, 60_000)

  it.each(providers)('%s: a suspended router (unselected active account) makes no monitoring or refresh calls', async provider => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [oauth(provider, 'cred_a'), { ...oauth(provider, 'cred_b', { expires: Date.now() - 60_000 }), inactive: true }, oauth(provider, 'cred_manual')] } })
    let session: string | undefined
    for (let index = 0; index < 3; index++) session = (await harness.run(provider, `turn ${index}`, session)).sessionID
    expect(harness.calls.filter(call => call.kind === 'usage')).toEqual([])
    expect(harness.primaries(provider).every(call => call.authorization === bearer('cred_manual'))).toBe(true)
  }, 60_000)

  it.each(providers)('%s: after OpenCode rotates the near-expiry active token, quota on the new token still fails over', async provider => {
    expectedRefreshes = 1
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [{ ...oauth(provider, 'cred_b'), inactive: false }, oauth(provider, 'cred_a', { expires: Date.now() + 60_000 })] } })
    const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws-cred_a' } })).toString('base64url')
    harness.respond(call => {
      if (call.kind === 'refresh') return Response.json({ access_token: 'access-cred_a-rotated', refresh_token: 'refresh-cred_a-2', id_token: `e30.${claims}.synthetic`, expires_in: 28_800, token_type: 'Bearer' })
      return call.kind === 'inference' && call.primary && call.authorization === 'Bearer access-cred_a-rotated' ? weeklyQuota(provider) : undefined
    })
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual(['Bearer access-cred_a-rotated', bearer('cred_b')])
    expect(await harness.active(provider)).toBe('cred_b')
  }, 60_000)

  it('anthropic: loaded before the auth plugin, the router fails closed instead of misattributing', async () => {
    harness = await start({ routerFirst: true, router: { anthropic: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { anthropic: [oauth('anthropic', 'cred_b'), oauth('anthropic', 'cred_a')] } })
    harness.respond(call => call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a') ? weeklyQuota('anthropic') : undefined)
    const result = await harness.run('anthropic')
    expect(result.failed).toBe(true)
    expect(await harness.active('anthropic')).toBe('cred_a')
  }, 60_000)
})

describe('anthropic inactive account with an expired stored token', () => {
  it('lets OpenCode refresh the backup account through its owner and then fails over to it', async () => {
    expectedRefreshes = 1
    harness = await start({ router: { anthropic: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { anthropic: [oauth('anthropic', 'cred_a'), { ...oauth('anthropic', 'cred_b', { expires: Date.now() - 60_000 }), inactive: true }] } })
    harness.respond(call => {
      if (call.kind === 'refresh') return Response.json({ access_token: 'access-cred_b-refreshed', refresh_token: 'refresh-cred_b-2', expires_in: 28_800, token_type: 'Bearer' })
      if (call.kind === 'usage' && call.authorization === 'Bearer access-cred_b') return new Response('stale token', { status: 401 })
      if (call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a')) return weeklyQuota('anthropic')
      return undefined
    })
    const result = await harness.run('anthropic')
    expect(result.text).toBe('fake success')
    expect(harness.calls.filter(call => call.kind === 'refresh')).toHaveLength(1)
    expect(harness.primaries('anthropic').map(call => call.authorization)).toEqual([bearer('cred_a'), 'Bearer access-cred_b-refreshed'])
    expect(await harness.active('anthropic')).toBe('cred_b')
  }, 60_000)

  it('a favorite never interrupts a healthy active selected account, even with more allowance', async () => {
    harness = await start({ router: { anthropic: { accountIDs: ['cred_a', 'cred_b'], favoriteAccountID: 'cred_b' } }, credentials: { anthropic: [oauth('anthropic', 'cred_b'), oauth('anthropic', 'cred_a')] } })
    harness.respond(call => call.kind === 'usage' ? usage('anthropic', call.authorization === bearer('cred_a') ? 80 : 5) : undefined)
    const result = await harness.run('anthropic')
    expect(result.text).toBe('fake success')
    expect(await harness.active('anthropic')).toBe('cred_a')
    expect(harness.primaries('anthropic').map(call => call.authorization)).toEqual([bearer('cred_a')])
  }, 60_000)
})

describe('stream safety', () => {
  it('never replays a response that already streamed output', async () => {
    harness = await start({ router: { anthropic: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { anthropic: [oauth('anthropic', 'cred_b'), oauth('anthropic', 'cred_a')] } })
    let failed = false
    harness.respond(call => {
      if (!(call.kind === 'inference' && call.primary) || failed) return undefined
      failed = true
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const partial = success('anthropic', 'partial')
          void partial.text().then(text => {
            controller.enqueue(new TextEncoder().encode(text.split('event: content_block_stop')[0]))
            controller.error(new Error('synthetic disconnect after output'))
          })
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    await harness.run('anthropic')
    expect(await harness.active('anthropic')).toBe('cred_a')
    expect((await harness.state()).cooldowns).toEqual({})
    expect(new Set(harness.primaries('anthropic').map(call => call.authorization))).toEqual(new Set([bearer('cred_a')]))
  }, 60_000)
})

describe('openai workspace header consistency under repeated failover', () => {
  it('every retried request pairs B\'s token with B\'s workspace across 15 independent failovers', async () => {
    for (let round = 0; round < 15; round++) {
      harness = await start({ router: { openai: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { openai: [oauth('openai', 'cred_b'), oauth('openai', 'cred_a')] } })
      harness.respond(call => call.kind === 'inference' && call.primary && call.authorization === bearer('cred_a') ? weeklyQuota('openai') : undefined)
      const result = await harness.run('openai')
      expect(result.text, `round ${round}`).toBe('fake success')
      for (const call of harness.calls.filter(item => item.kind === 'inference')) {
        expect(call.workspace, `round ${round} ${call.authorization}`).toBe(call.authorization === bearer('cred_b') ? 'ws-cred_b' : 'ws-cred_a')
      }
      await harness.close()
      harness = undefined
    }
  }, 120_000)
})

describe.each(providers)('%s smart routing through real OpenCode core', provider => {
  /** Usage whose 5-hour window resets after `minutes(token)` minutes. */
  const windows = (minutes: (authorization: string | null) => number) => (call: Parameters<Parameters<Harness['respond']>[0]>[0]) => {
    if (call.kind !== 'usage') return undefined
    const reset = Date.now() + minutes(call.authorization) * 60_000
    const weekly = Date.now() + 5 * 86_400_000
    return provider === 'anthropic'
      ? Response.json({ five_hour: { utilization: 14, resets_at: new Date(reset).toISOString() }, seven_day: { utilization: 30, resets_at: new Date(weekly).toISOString() } })
      : Response.json({ plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 14, limit_window_seconds: 18_000, reset_at: Math.floor(reset / 1000) }, secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: Math.floor(weekly / 1000) } } })
  }

  it('sends the first conversation to the account whose 5-hour allowance expires first, then stays while its cache is warm', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [oauth(provider, 'cred_b'), oauth(provider, 'cred_a')] } })
    expect(await harness.active(provider)).toBe('cred_a')
    harness.respond(windows(authorization => authorization === bearer('cred_b') ? 102 : 222))
    const first = await harness.run(provider)
    expect(first.text).toBe('fake success')
    // The switch happens at the prompt boundary, so even the very first request uses B.
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual([bearer('cred_b')])
    if (provider === 'openai') expect(harness.primaries(provider).map(call => call.workspace)).toEqual(['ws-cred_b'])
    expect(await harness.active(provider)).toBe('cred_b')
    expect((await harness.state()).sticky[provider]).toBe('cred_b')
    // Conversation activity is saved in the background (throttled), for restarts and other OpenCode processes.
    const engine = harness
    await expect.poll(async () => (await engine.state()).activity?.[provider] ?? 0).toBeGreaterThan(Date.now() - 60_000)
    // Now A would expire first, but another conversation just used B: a new thread must not drop that cache.
    harness.respond(windows(authorization => authorization === bearer('cred_a') ? 10 : 222))
    const second = await harness.run(provider, 'new thread')
    const third = await harness.run(provider, 'same thread', first.sessionID)
    expect([second.text, third.text]).toEqual(['fake success', 'fake success'])
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual([bearer('cred_b'), bearer('cred_b'), bearer('cred_b')])
    expect(await harness.active(provider)).toBe('cred_b')
    const logPath = join(dirname(harness.statePath), 'account-router.log')
    await expect.poll(async () => readFile(logPath, 'utf8')).toMatch(/WAIT/)
    const log = await readFile(logPath, 'utf8')
    expect(log).toMatch(new RegExp(`\\| INFO  \\| ${provider} \\| SWITCH \\| Synthetic cred_a → Synthetic cred_b \\| Synthetic cred_b's 5-hour window resets in 1h 42m, Synthetic cred_a's in 3h 42m`))
    expect(log).toMatch(new RegExp(`\\| INFO  \\| ${provider} \\| WAIT \\| Synthetic cred_b \\| New session, but a conversation used this account moments ago`))
    // Which account served each conversation, the detected cache window, and usage checks are all on record.
    expect(log).toMatch(new RegExp(`\\| ${provider} \\| USE \\| Synthetic cred_b \\| Session ses_\\S+ \\(${MODELS[provider]}\\)\\.`))
    expect(log).toContain(`| ${provider} | CACHE | - | Prompt cache counts as warm for ${provider === 'anthropic' ? '5m' : '30m'} after a conversation request (${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} default; OpenCode sends no cache.ttl).`)
    expect(log).toMatch(new RegExp(`\\| ${provider} \\| USAGE \\| Synthetic cred_a \\| 5-hour 14% \\(resets in 3h 4[12]m\\)`))
    expect(log).toMatch(/\| router \| LOADED \| - \| Router \S+ started \(strategy smart/)
    expect(log).not.toMatch(/access-|refresh-/)
  }, 60_000)

  it('detects a 1-hour cache.ttl from the real OpenCode config and logs it', async () => {
    harness = await start({
      router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } },
      credentials: { [provider]: [oauth(provider, 'cred_b'), oauth(provider, 'cred_a')] },
      opencodeConfig: { providers: { [provider]: { settings: { cache: { ttl: '1h' } } } } },
    })
    harness.respond(windows(authorization => authorization === bearer('cred_b') ? 102 : 222))
    expect((await harness.run(provider)).text).toBe('fake success')
    const logPath = join(dirname(harness.statePath), 'account-router.log')
    await expect.poll(async () => readFile(logPath, 'utf8')).toContain(`| ${provider} | CACHE | - | Prompt cache counts as warm for 1h 0m after a conversation request (OpenCode cache.ttl setting (1h 0m)).`)
  }, 60_000)

  it('keeps the active account when the other expires only slightly sooner', async () => {
    harness = await start({ router: { [provider]: { accountIDs: ['cred_a', 'cred_b'] } }, credentials: { [provider]: [oauth(provider, 'cred_b'), oauth(provider, 'cred_a')] } })
    harness.respond(windows(authorization => authorization === bearer('cred_b') ? 100 : 120))
    const result = await harness.run(provider)
    expect(result.text).toBe('fake success')
    expect(harness.primaries(provider).map(call => call.authorization)).toEqual([bearer('cred_a')])
    expect(await harness.active(provider)).toBe('cred_a')
  }, 60_000)
})
