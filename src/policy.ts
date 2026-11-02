import type { Account, ProviderConfig, UsageSnapshot } from './types.js'

export function freshUsage(usage: UsageSnapshot | undefined, now: number, maxAge = 600_000): usage is UsageSnapshot {
  return !!usage && usage.status === 'ok' && usage.checkedAt <= now && now - usage.checkedAt <= maxAge
}

export function usageBlocks(usage: UsageSnapshot | undefined, now: number, maxAge = 600_000): boolean {
  if (!freshUsage(usage, now, maxAge)) return false
  if (usage.allowed !== undefined) return !usage.allowed
  return usage.windows.some(window => !window.model && window.usedPercent === 100 && window.resetsAt !== null && window.resetsAt > now)
}

export function chooseInitial(config: ProviderConfig, accounts: Account[], usage: UsageSnapshot[], now: number): { accountID?: string; reason: string } {
  const selected = accounts.filter(account => account.method === 'oauth' && config.accountIDs.includes(account.id) && !account.needsAuth)
  const active = selected.find(account => account.active)
  if (active) return { accountID: active.id, reason: 'Keep the active selected account sticky; monitoring alone never switches it.' }
  const eligible = selected.filter(account => !usageBlocks(usage.find(value => value.accountID === account.id && value.provider === account.provider), now))
  const favorite = eligible.find(account => account.id === config.favoriteAccountID)
  if (favorite) return { accountID: favorite.id, reason: 'Use the selected favorite for initial selection.' }
  const score = (account: Account): number[] => {
    const item = usage.find(value => value.accountID === account.id && value.provider === account.provider)
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
  return eligible[0] ? { accountID: eligible[0].id, reason: 'Prefer a running window, then remaining weekly allowance; keep this choice sticky.' } : { reason: 'No eligible selected subscription; initial selection never authorizes paid fallback.' }
}
