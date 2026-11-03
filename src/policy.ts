import { duration } from './display.js'
import type { Account, ProviderConfig, ProviderID, RoutingStrategy, UsageSnapshot, UsageWindow } from './types.js'

export function freshUsage(usage: UsageSnapshot | undefined, now: number, maxAge = 600_000): usage is UsageSnapshot {
  return !!usage && usage.status === 'ok' && usage.checkedAt <= now && now - usage.checkedAt <= maxAge
}

export function usageBlocks(usage: UsageSnapshot | undefined, now: number, maxAge = 600_000): boolean {
  if (!freshUsage(usage, now, maxAge)) return false
  if (usage.allowed !== undefined) return !usage.allowed
  return usage.windows.some(window => !window.model && window.usedPercent === 100 && window.resetsAt !== null && window.resetsAt > now)
}

/**
 * Prompt-cache lifetime each provider uses when OpenCode sends no `cache.ttl` (OpenCode's default):
 * Anthropic's ephemeral cache lasts 5 minutes; OpenAI's lasts 30 minutes on GPT-5.6+ (and typically
 * around 30 minutes with the 24h retention older models default to).
 */
export const DEFAULT_CACHE_WINDOW_MS: Record<ProviderID, number> = { anthropic: 300_000, openai: 1_800_000 }

const TTL_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parses an OpenCode/models.dev cache lifetime such as "5m", "1h" or "24h"; anything else is ignored. */
export function parseCacheTTL(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,7})(ms|s|m|h|d)$/u.exec(value.trim())
  if (!match) return undefined
  const milliseconds = Number(match[1]) * TTL_UNITS[match[2]!]!
  return milliseconds > 0 && milliseconds <= 7 * 86_400_000 ? milliseconds : undefined
}

const WEEK_SECONDS = 604_800
/** An account with less than this left in any window is not worth moving a conversation onto. */
export const HEADROOM_PERCENT = 5
/** A smart switch needs the other 5-hour window to expire at least this much sooner, so routing never flaps. */
export const SESSION_MARGIN_MS = 30 * 60_000
/** Same idea for weekly windows when the 5-hour windows do not decide. */
export const WEEKLY_MARGIN_MS = 12 * 3_600_000

/** What fresh usage says about one account, reduced to what routing compares. */
export interface Standing {
  fresh: boolean
  blocked: boolean
  /** At least HEADROOM_PERCENT left in every account-wide window. */
  headroom: boolean
  /** Lowest allowance left across account-wide windows. */
  left: number
  /** Reset of the running short (5-hour) window; unset when none is running. */
  sessionReset?: number
  /** Reset of the running weekly window; unset when none is running. */
  weeklyReset?: number
}

function remaining(window: UsageWindow, now: number): number {
  return window.resetsAt !== null && window.resetsAt <= now ? 100 : 100 - (window.usedPercent ?? 0)
}

export function standing(usage: UsageSnapshot | undefined, now: number, maxAge = 600_000): Standing {
  if (!freshUsage(usage, now, maxAge)) return { fresh: false, blocked: false, headroom: false, left: 0 }
  const windows = usage.windows.filter(window => !window.model && window.usedPercent !== null)
  const blocked = usageBlocks(usage, now, maxAge)
  const left = windows.length ? Math.min(...windows.map(window => remaining(window, now))) : 100
  const running = (long: boolean): number | undefined => {
    const resets = windows
      .filter(window => window.durationSeconds !== undefined && (window.durationSeconds >= WEEK_SECONDS) === long && window.resetsAt !== null && window.resetsAt > now)
      .map(window => window.resetsAt!)
    return resets.length ? Math.min(...resets) : undefined
  }
  const sessionReset = running(false)
  const weeklyReset = running(true)
  return { fresh: true, blocked, headroom: !blocked && left >= HEADROOM_PERCENT, left, ...(sessionReset !== undefined ? { sessionReset } : {}), ...(weeklyReset !== undefined ? { weeklyReset } : {}) }
}

/**
 * Smart order: known usage, not exhausted, real headroom, then the allowance that expires soonest
 * (running 5-hour window first, then running weekly window), then the most room left.
 */
export function compareStanding(a: Standing, b: Standing): number {
  const keys: ((value: Standing) => number)[] = [
    value => (value.fresh ? 0 : 1),
    value => (value.blocked ? 1 : 0),
    value => (value.headroom ? 0 : 1),
    value => value.sessionReset ?? Infinity,
    value => value.weeklyReset ?? Infinity,
    value => -value.left,
  ]
  for (const key of keys) {
    const difference = key(a) - key(b)
    if (difference !== 0 && !Number.isNaN(difference)) return difference
  }
  return 0
}

function usageFor(usage: UsageSnapshot[], account: Account): UsageSnapshot | undefined {
  return usage.find(value => value.accountID === account.id && value.provider === account.provider)
}

/** Ranks accounts best-first for smart routing; ties go to the favorite, then configured order. */
export function rankAccounts(config: ProviderConfig, accounts: Account[], usage: UsageSnapshot[], now: number, maxAge = 600_000): Account[] {
  const standings = new Map(accounts.map(account => [account.id, standing(usageFor(usage, account), now, maxAge)]))
  return [...accounts].sort((left, right) =>
    compareStanding(standings.get(left.id)!, standings.get(right.id)!)
    || Number(right.id === config.favoriteAccountID) - Number(left.id === config.favoriteAccountID)
    || config.accountIDs.indexOf(left.id) - config.accountIDs.indexOf(right.id))
}

export type ChoiceKind = 'sticky' | 'favorite' | 'best' | 'none'

export function chooseInitial(config: ProviderConfig, accounts: Account[], usage: UsageSnapshot[], now: number, strategy: RoutingStrategy = 'sticky'): { accountID?: string; reason: string; kind: ChoiceKind } {
  const selected = accounts.filter(account => account.method === 'oauth' && config.accountIDs.includes(account.id) && !account.needsAuth)
  const active = selected.find(account => account.active)
  if (active) return { accountID: active.id, kind: 'sticky', reason: 'Keep the active selected account sticky; monitoring alone never switches it.' }
  const eligible = selected.filter(account => !usageBlocks(usageFor(usage, account), now))
  if (strategy === 'smart') {
    const [best] = rankAccounts(config, eligible, usage, now)
    return best ? { accountID: best.id, kind: 'best', reason: 'Use the allowance that expires soonest, then the one with most room left.' } : { kind: 'none', reason: 'No eligible selected subscription; initial selection never authorizes paid fallback.' }
  }
  const favorite = eligible.find(account => account.id === config.favoriteAccountID)
  if (favorite) return { accountID: favorite.id, kind: 'favorite', reason: 'Use the selected favorite for initial selection.' }
  const score = (account: Account): number[] => {
    const item = usageFor(usage, account)
    if (!freshUsage(item, now)) return [0, 0, 0]
    const session = item.windows.find(window => !window.model && window.durationSeconds === 18_000)
    const weekly = item.windows.find(window => !window.model && window.durationSeconds === 604_800)
    return [1, Number(session?.resetsAt !== null && session?.resetsAt !== undefined && session.resetsAt > now), weekly?.usedPercent === null || weekly?.usedPercent === undefined ? -1 : 100 - weekly.usedPercent]
  }
  eligible.sort((left, right) => {
    const a = score(left), b = score(right)
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return b[index]! - a[index]!
    return config.accountIDs.indexOf(left.id) - config.accountIDs.indexOf(right.id)
  })
  return eligible[0] ? { accountID: eligible[0].id, kind: 'best', reason: 'Prefer a running window, then remaining weekly allowance; keep this choice sticky.' } : { kind: 'none', reason: 'No eligible selected subscription; initial selection never authorizes paid fallback.' }
}

export interface RebalancePlan {
  /** Set only when switching is clearly better. */
  accountID?: string
  kind: 'switch' | 'keep'
  reason: string
}

/**
 * Smart routing at a cache-safe moment: should the active account give way to another selected one?
 * Only switches for a clear win (allowance expiring meaningfully sooner, or the current one out of room),
 * and never on missing or stale usage, so the same evidence cannot make it switch back.
 */
export function planRebalance(config: ProviderConfig, current: Account, candidates: Account[], usage: UsageSnapshot[], now: number, options: { maxAge?: number; currentBlocked?: boolean } = {}): RebalancePlan {
  const maxAge = options.maxAge ?? 600_000
  const others = candidates.filter(account => account.id !== current.id && account.provider === current.provider && account.method === 'oauth' && !account.needsAuth && config.accountIDs.includes(account.id))
  const [best] = rankAccounts(config, others, usage, now, maxAge)
  const keep = (reason: string): RebalancePlan => ({ kind: 'keep', reason })
  if (!best) return keep('No other selected account is available.')
  const move = (reason: string): RebalancePlan => ({ accountID: best.id, kind: 'switch', reason })
  const b = standing(usageFor(usage, best), now, maxAge)
  const c = standing(usageFor(usage, current), now, maxAge)
  const at = (time: number): string => duration(time - now)
  if (!b.fresh) return keep(`No recent usage for ${best.label} yet.`)
  if (b.blocked || !b.headroom) return keep(`${best.label} has no room left either.`)
  if (options.currentBlocked || c.blocked) return move(`${current.label} is out of allowance.`)
  if (!c.fresh) return keep(`No recent usage for ${current.label} yet.`)
  if (!c.headroom) return move(`${current.label} has under ${HEADROOM_PERCENT}% left.`)
  if (b.sessionReset !== undefined && c.sessionReset === undefined) {
    return move(`${best.label}'s 5-hour window is already running (resets in ${at(b.sessionReset)}) and ${current.label}'s is not, so use the running one first.`)
  }
  if (b.sessionReset !== undefined && c.sessionReset !== undefined) {
    if (b.sessionReset + SESSION_MARGIN_MS <= c.sessionReset) {
      return move(`${best.label}'s 5-hour window resets in ${at(b.sessionReset)}, ${current.label}'s in ${at(c.sessionReset)}; use the allowance that expires first.`)
    }
    if (c.sessionReset + SESSION_MARGIN_MS <= b.sessionReset) return keep(`${current.label}'s 5-hour window resets first (${at(c.sessionReset)} vs ${at(b.sessionReset)}).`)
  } else if (c.sessionReset !== undefined) return keep(`${current.label}'s 5-hour window is running and ${best.label}'s is not.`)
  if (b.weeklyReset !== undefined && (c.weeklyReset === undefined || b.weeklyReset + WEEKLY_MARGIN_MS <= c.weeklyReset)) {
    return move(`${best.label}'s weekly allowance resets in ${at(b.weeklyReset)}, ${c.weeklyReset === undefined ? `${current.label}'s has not started` : `${current.label}'s in ${at(c.weeklyReset)}`}; use the allowance that expires first.`)
  }
  return keep(`No other account's allowance expires meaningfully sooner than ${current.label}'s.`)
}
