import { describe, expect, it } from 'vitest'
import { chooseInitial, freshUsage, usageBlocks } from '../src/policy.js'
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
