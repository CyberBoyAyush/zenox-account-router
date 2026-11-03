import { describe, expect, it } from 'vitest'
import { chooseInitial, compareStanding, freshUsage, planRebalance, rankAccounts, standing, usageBlocks } from '../src/policy.js'
import type { Account, ProviderConfig, UsageSnapshot, UsageWindow } from '../src/types.js'

const now = Date.parse('2026-11-02T12:00:00Z')
const config: ProviderConfig = { accountIDs: ['a', 'b'], allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['model'] }
const account = (id: string, overrides: Partial<Account> = {}): Account => ({ id, provider: 'anthropic', label: `Synthetic ${id}`, method: 'oauth', active: false, ...overrides })
const window = (durationSeconds: number, usedPercent: number | null, resetsAt: number | null = now + 60_000, model?: string): UsageWindow => ({ id: String(durationSeconds), label: 'Synthetic window', durationSeconds, usedPercent, resetsAt, ...(model ? { model } : {}) })
const usage = (accountID: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ provider: 'anthropic', accountID, checkedAt: now, status: 'ok', windows: [], ...overrides })

describe('usage evidence boundaries', () => {
  it('requires successful, nonfuture evidence at or inside the freshness boundary', () => {
    expect(freshUsage(undefined, now)).toBe(false)
    expect(freshUsage(usage('a', { checkedAt: now - 600_000 }), now)).toBe(true)
    expect(freshUsage(usage('a', { checkedAt: now - 600_001 }), now)).toBe(false)
    expect(freshUsage(usage('a', { checkedAt: now + 1 }), now)).toBe(false)
    expect(freshUsage(usage('a', { checkedAt: now - 11 }), now, 10)).toBe(false)
    for (const status of ['expired', 'needs-auth', 'rate-limited', 'unavailable', 'unsupported'] as const) {
      expect(freshUsage(usage('a', { status }), now), status).toBe(false)
    }
  })

  it('uses authoritative allowed flags ahead of displayed percentages', () => {
    expect(usageBlocks(usage('a', { allowed: true, windows: [window(18_000, 100)] }), now)).toBe(false)
    expect(usageBlocks(usage('a', { allowed: false }), now)).toBe(true)
    expect(usageBlocks(usage('a', { allowed: false, checkedAt: now - 600_001 }), now)).toBe(false)
  })

  it('only blocks a fresh account-wide 100% window with a future reset', () => {
    expect(usageBlocks(usage('a', { windows: [window(604_800, 100)] }), now)).toBe(true)
    for (const candidate of [window(18_000, 99.99), window(18_000, null), window(18_000, 100, null), window(18_000, 100, now), window(18_000, 100, now - 1), window(18_000, 100, now + 1, 'opus')]) {
      expect(usageBlocks(usage('a', { windows: [candidate] }), now), JSON.stringify(candidate)).toBe(false)
    }
    expect(usageBlocks(undefined, now)).toBe(false)
    expect(usageBlocks(usage('a', { windows: [window(18_000, 100)], checkedAt: now - 21 }), now, 20)).toBe(false)
  })
})

describe('initial subscription selection', () => {
  it('keeps the active selected OAuth sticky even when a favorite is healthier and fresh usage is 100%', () => {
    expect(chooseInitial({ ...config, favoriteAccountID: 'b' }, [account('a', { active: true }), account('b')], [usage('a', { windows: [window(18_000, 100)] })], now).accountID).toBe('a')
  })

  it('uses an eligible favorite before running-window and weekly ranking', () => {
    const evidence = [usage('a', { windows: [window(604_800, 99)] }), usage('b', { windows: [window(18_000, 10), window(604_800, 0)] })]
    expect(chooseInitial({ ...config, favoriteAccountID: 'a' }, [account('a'), account('b')], evidence, now).accountID).toBe('a')
    evidence[0] = usage('a', { allowed: false })
    expect(chooseInitial({ ...config, favoriteAccountID: 'a' }, [account('a'), account('b')], evidence, now).accountID).toBe('b')
  })

  it('prefers a running five-hour window over a better weekly balance', () => {
    const evidence = [usage('a', { windows: [window(18_000, 80), window(604_800, 90)] }), usage('b', { windows: [window(18_000, 0, null), window(604_800, 1)] })]
    expect(chooseInitial(config, [account('b'), account('a')], evidence, now).accountID).toBe('a')
  })

  it('compares weekly allowance left when running-window ranks tie, independent of response order', () => {
    const evidence = [usage('a', { windows: [window(604_800, 80), window(18_000, 1)] }), usage('b', { windows: [window(18_000, 99), window(604_800, 20)] })]
    expect(chooseInitial(config, [account('a'), account('b')], evidence, now).accountID).toBe('b')
    expect(chooseInitial(config, [account('b'), account('a')], evidence.toReversed(), now).accountID).toBe('b')
  })

  it('breaks equal and unknown evidence ties by configured selection order', () => {
    expect(chooseInitial(config, [account('b'), account('a')], [], now).accountID).toBe('a')
    expect(chooseInitial({ ...config, accountIDs: ['b', 'a'] }, [account('a'), account('b')], [usage('a'), usage('b')], now).accountID).toBe('b')
    expect(chooseInitial(config, [account('a'), account('b')], [usage('a', { windows: [window(604_800, null)] }), usage('b', { windows: [window(604_800, 99)] })], now).accountID).toBe('b')
  })

  it('ignores stale/future/failed and other-provider evidence for ranking and blocking', () => {
    for (const overrides of [{ checkedAt: now - 600_001 }, { checkedAt: now + 1 }, { status: 'unavailable' as const }, { provider: 'openai' as const }]) {
      expect(chooseInitial(config, [account('a'), account('b')], [usage('a', { ...overrides, allowed: false, windows: [window(18_000, 100)] }), usage('b')], now).accountID).toBe('b')
    }
  })

  it('never uses paid fallback for initial selection even with every subscription blocked', () => {
    expect(chooseInitial(config, [account('a'), account('b'), account('key', { method: 'key', active: true })], [usage('a', { allowed: false }), usage('b', { allowed: false })], now).accountID).toBeUndefined()
  })

  it('exhaustively returns only a selected authenticated OAuth candidate, never a key or outsider', () => {
    for (let mask = 0; mask < 256; mask++) {
      const candidates = [account('a', { active: !!(mask & 1), needsAuth: !!(mask & 2) }), account('b', { active: !!(mask & 4), needsAuth: !!(mask & 8) }), account('key', { method: 'key', active: true }), account('outside', { active: true })]
      const settings = { ...config, accountIDs: ['a', 'b'].filter((_, index) => !!(mask & (16 << index))), ...(mask & 64 ? { favoriteAccountID: 'a' } : {}) }
      const evidence = [usage('a', { allowed: !(mask & 128) }), usage('b', { allowed: false })]
      const result = chooseInitial(settings, candidates, evidence, now)
      if (result.accountID) {
        const chosen = candidates.find(candidate => candidate.id === result.accountID)
        expect(chosen, `mask=${mask}`).toMatchObject({ method: 'oauth', needsAuth: false })
        expect(settings.accountIDs, `mask=${mask}`).toContain(result.accountID)
        if (!chosen?.active) expect(usageBlocks(evidence.find(item => item.accountID === chosen?.id), now), `mask=${mask}`).toBe(false)
      } else {
        expect(candidates.filter(candidate => candidate.method === 'oauth' && !candidate.needsAuth && settings.accountIDs.includes(candidate.id) && (candidate.active || !usageBlocks(evidence.find(item => item.accountID === candidate.id), now))), `mask=${mask}`).toHaveLength(0)
      }
    }
  })
})

describe('smart standing and ranking', () => {
  const at = (minutes: number): number => now + minutes * 60_000
  const smart = (accountID: string, session: number | null, weekly: number | null, used = 20, weeklyUsed = 30): UsageSnapshot => usage(accountID, { windows: [window(18_000, session === null ? 0 : used, session === null ? null : at(session)), window(604_800, weeklyUsed, weekly === null ? null : at(weekly))] })

  it('summarises fresh usage into running resets, room left and headroom', () => {
    expect(standing(smart('a', 90, 3000, 40, 70), now)).toEqual({ fresh: true, blocked: false, headroom: true, left: 30, sessionReset: at(90), weeklyReset: at(3000) })
    expect(standing(smart('a', null, null), now)).toEqual({ fresh: true, blocked: false, headroom: true, left: 70 })
    expect(standing(smart('a', 90, 3000, 96), now)).toMatchObject({ headroom: false, left: 4 })
    expect(standing(smart('a', 90, 3000, 100), now)).toMatchObject({ blocked: true, headroom: false })
    expect(standing(usage('a', { allowed: false, windows: [] }), now)).toMatchObject({ blocked: true, headroom: false })
    // A window that already reset counts as full and not running.
    expect(standing(usage('a', { windows: [window(18_000, 100, now - 1)] }), now)).toEqual({ fresh: true, blocked: false, headroom: true, left: 100 })
    // Model-only and unknown windows never decide account-wide routing.
    expect(standing(usage('a', { windows: [window(18_000, 100, at(10), 'opus'), window(604_800, null, at(10))] }), now)).toEqual({ fresh: true, blocked: false, headroom: true, left: 100 })
    for (const overrides of [{ checkedAt: now - 600_001 }, { checkedAt: now + 1 }, { status: 'unavailable' as const }]) {
      expect(standing(usage('a', { ...overrides, windows: [window(18_000, 10, at(10))] }), now)).toEqual({ fresh: false, blocked: false, headroom: false, left: 0 })
    }
  })

  it('orders known, usable, roomy accounts first, then the allowance that expires soonest', () => {
    const ordered = [
      standing(smart('a', 30, 1000), now),
      standing(smart('a', 60, 500), now),
      standing(smart('a', null, 400), now),
      standing(smart('a', null, null), now),
      standing(smart('a', 10, 100, 97), now),
      standing(smart('a', 10, 100, 100), now),
      standing(undefined, now),
    ]
    for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
      expect(Math.sign(compareStanding(ordered[i]!, ordered[j]!)), `${i} vs ${j}`).toBe(Math.sign(i - j))
    }
  })

  it('breaks exact ties by favorite, then configured order', () => {
    const accounts = [account('a'), account('b'), account('c')]
    const same = ['a', 'b', 'c'].map(id => smart(id, 60, 1000))
    expect(rankAccounts({ ...config, accountIDs: ['a', 'b', 'c'] }, accounts, same, now).map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(rankAccounts({ ...config, accountIDs: ['a', 'b', 'c'], favoriteAccountID: 'c' }, accounts, same, now).map(item => item.id)).toEqual(['c', 'a', 'b'])
    expect(rankAccounts({ ...config, accountIDs: ['c', 'b', 'a'] }, accounts, same, now).map(item => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('smart initial choice drains the soonest-expiring allowance, with the favorite only as a tie-break', () => {
    const evidence = [smart('a', 200, 1000), smart('b', 60, 1000)]
    expect(chooseInitial({ ...config, favoriteAccountID: 'a' }, [account('a'), account('b')], evidence, now, 'smart')).toMatchObject({ accountID: 'b', kind: 'best' })
    expect(chooseInitial({ ...config, favoriteAccountID: 'a' }, [account('a'), account('b')], evidence, now, 'sticky')).toMatchObject({ accountID: 'a', kind: 'favorite' })
    expect(chooseInitial({ ...config, favoriteAccountID: 'b' }, [account('a'), account('b')], [smart('a', 60, 1000), smart('b', 60, 1000)], now, 'smart').accountID).toBe('b')
    expect(chooseInitial(config, [account('a', { active: true }), account('b')], evidence, now, 'smart')).toMatchObject({ accountID: 'a', kind: 'sticky' })
    expect(chooseInitial(config, [account('a'), account('b'), account('key', { method: 'key' })], [usage('a', { allowed: false }), usage('b', { allowed: false })], now, 'smart').accountID).toBeUndefined()
  })
})

describe('smart rebalance plan', () => {
  const at = (minutes: number): number => now + minutes * 60_000
  const smart = (accountID: string, session: number | null, weekly: number | null, used = 20, weeklyUsed = 30): UsageSnapshot => usage(accountID, { windows: [window(18_000, session === null ? 0 : used, session === null ? null : at(session)), window(604_800, weeklyUsed, weekly === null ? null : at(weekly))] })
  const a = account('a', { active: true, label: 'Vranda' })
  const b = account('b', { label: 'Team' })
  const plan = (evidence: UsageSnapshot[], options: Parameters<typeof planRebalance>[5] = {}, candidates = [b]) => planRebalance(config, a, candidates, evidence, now, options)

  it("switches in the user's case: the standby's 5-hour window expires two hours sooner", () => {
    expect(plan([smart('a', 222, 6960, 14, 30), smart('b', 102, 5700, 2, 22)])).toEqual({
      accountID: 'b', kind: 'switch',
      reason: "Team's 5-hour window resets in 1h 42m, Vranda's in 3h 42m; use the allowance that expires first.",
    })
  })

  it('needs at least a 30-minute lead on the 5-hour window', () => {
    expect(plan([smart('a', 120, 1000), smart('b', 91, 1000)]).kind).toBe('keep')
    expect(plan([smart('a', 120, 1000), smart('b', 90, 1000)]).kind).toBe('switch')
    expect(plan([smart('a', 60, 1000), smart('b', 120, 1000)])).toMatchObject({ kind: 'keep', reason: "Vranda's 5-hour window resets first (1h 0m vs 2h 0m)." })
  })

  it('prefers draining a running window over starting a new one', () => {
    expect(plan([smart('a', null, 1000), smart('b', 200, 1000)])).toMatchObject({ kind: 'switch', accountID: 'b' })
    expect(plan([smart('a', 200, 1000), smart('b', null, 1000)])).toMatchObject({ kind: 'keep', reason: "Vranda's 5-hour window is running and Team's is not." })
  })

  it('falls back to weekly resets with a 12-hour lead when 5-hour windows do not decide', () => {
    expect(plan([smart('a', null, 2000), smart('b', null, 2000 - 720)]).kind).toBe('switch')
    expect(plan([smart('a', null, 2000), smart('b', null, 2000 - 719)]).kind).toBe('keep')
    expect(plan([smart('a', 100, 2000), smart('b', 90, 1000)])).toMatchObject({ kind: 'switch', accountID: 'b' })
    expect(plan([smart('a', null, null), smart('b', null, 3000)])).toMatchObject({ kind: 'switch', reason: "Team's weekly allowance resets in 2d 2h, Vranda's has not started; use the allowance that expires first." })
    expect(plan([smart('a', null, 3000), smart('b', null, null)]).kind).toBe('keep')
  })

  it('moves off an exhausted or nearly empty account, but never onto one', () => {
    expect(plan([smart('a', 200, 1000, 100), smart('b', 300, 1000)])).toMatchObject({ kind: 'switch', reason: 'Vranda is out of allowance.' })
    expect(plan([smart('a', 200, 1000), smart('b', 300, 1000)], { currentBlocked: true })).toMatchObject({ kind: 'switch' })
    expect(plan([smart('a', 200, 1000, 96), smart('b', 300, 1000)])).toMatchObject({ kind: 'switch', reason: 'Vranda has under 5% left.' })
    expect(plan([smart('a', 200, 1000, 20, 96), smart('b', 300, 1000)])).toMatchObject({ kind: 'switch' })
    for (const other of [smart('b', 10, 1000, 100), smart('b', 10, 1000, 96), smart('b', 10, 1000, 20, 99), usage('b', { allowed: false })]) {
      expect(plan([smart('a', 200, 1000, 100), other]), JSON.stringify(other)).toMatchObject({ kind: 'keep', reason: 'Team has no room left either.' })
    }
  })

  it('never acts on missing or stale usage', () => {
    expect(plan([smart('a', 200, 1000)])).toMatchObject({ kind: 'keep', reason: 'No recent usage for Team yet.' })
    expect(plan([smart('b', 10, 1000)])).toMatchObject({ kind: 'keep', reason: 'No recent usage for Vranda yet.' })
    expect(plan([smart('a', 200, 1000), { ...smart('b', 10, 1000), checkedAt: now - 600_001 }]).kind).toBe('keep')
    expect(plan([smart('a', 200, 1000), { ...smart('b', 10, 1000), checkedAt: now - 120_000 }], { maxAge: 60_000 }).kind).toBe('keep')
  })

  it('only considers selected, signed-in subscriptions of the same provider other than the current one', () => {
    const evidence = [smart('a', 200, 1000), smart('b', 10, 1000), smart('key', 10, 1000), smart('outside', 10, 1000), { ...smart('c', 10, 1000), provider: 'openai' as const }]
    const candidates = [a, account('b', { needsAuth: true }), account('key', { method: 'key' }), account('outside'), account('c', { provider: 'openai' })]
    expect(planRebalance({ ...config, accountIDs: ['a', 'b', 'c'] }, a, candidates, evidence, now)).toEqual({ kind: 'keep', reason: 'No other selected account is available.' })
  })

  it('picks the best of several candidates', () => {
    const c = account('c', { label: 'Spare' })
    const evidence = [smart('a', 250, 1000), smart('b', 200, 1000), smart('c', 60, 1000)]
    expect(planRebalance({ ...config, accountIDs: ['a', 'b', 'c'] }, a, [b, c], evidence, now)).toMatchObject({ kind: 'switch', accountID: 'c' })
  })

  it('is never undone by the same evidence (no flapping), exhaustively over a grid of usage', () => {
    const sessions = [null, 5, 30, 61, 120, 299]
    const weeks = [null, 100, 900, 2000, 9000]
    const used = [0, 50, 95, 96, 100]
    const grid: UsageSnapshot[][] = []
    for (const s of sessions) for (const w of weeks) for (const u of used) grid.push([smart('x', s, w, u, u === 100 ? 30 : 40)])
    let switches = 0
    for (const [left] of grid) for (const [right] of grid) {
      const evidence = [{ ...left!, accountID: 'a' }, { ...right!, accountID: 'b' }]
      const forward = planRebalance(config, account('a', { active: true }), [account('b')], evidence, now)
      if (forward.kind !== 'switch') continue
      switches++
      const back = planRebalance(config, account('b', { active: true }), [account('a')], evidence, now)
      expect(back.kind, `${JSON.stringify(evidence)} -> ${forward.reason} / ${back.reason}`).toBe('keep')
      expect(usageBlocks(evidence[1], now)).toBe(false)
    }
    expect(switches).toBeGreaterThan(grid.length * 10)
  })
})
