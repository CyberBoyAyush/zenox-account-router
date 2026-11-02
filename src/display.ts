import type { Account, ProviderID, RouterConfig, RouterState } from './types.js'
import { stripVTControlCharacters } from 'node:util'

export function cleanLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 160)
}

export function displayAccounts(accounts: Account[]): string {
  if (!accounts.length) return 'No Anthropic or OpenAI accounts found. Sign in with OpenCode first.'
  return accounts.map(account => `${account.provider}  ${cleanLabel(account.id)}  ${cleanLabel(account.label)}  ${account.method}${account.active ? ' (active)' : ''}${account.needsAuth ? ' (needs sign-in)' : ''}`).join('\n')
}

export function displayStatus(config: RouterConfig, state: RouterState): string {
  const lines = ['Saved state only; use --refresh to request live usage.']
  for (const [provider, settings] of Object.entries(config.providers)) {
    if (!settings) continue
    const sticky = state.sticky[provider as ProviderID]
    const label = (id: string): string => cleanLabel(settings.accountLabels?.[id] ?? id)
    lines.push(`${provider}: ${settings.accountIDs.length} OAuth account(s); favorite ${settings.favoriteAccountID ? label(settings.favoriteAccountID) : 'automatic'}; paid fallback ${settings.allowPaidFallback ? 'enabled (provider-global billing)' : 'disabled'}`)
    for (const accountID of settings.accountIDs) {
      const usage = Object.values(state.usage).find(value => value.provider === provider && value.accountID === accountID)
      const status = sticky === accountID ? 'sticky (saved)' : 'standby'
      lines.push(`  ${label(accountID)} [${cleanLabel(accountID)}] — ${status}: ${usage ? `${usage.status}, checked ${new Date(usage.checkedAt).toISOString()}${Date.now() - usage.checkedAt > config.pollIntervalMs ? ' (stale)' : ''}; ${usage.windows.map(window => `${cleanLabel(window.label)}: ${window.usedPercent === null ? 'unknown usage' : `${window.usedPercent}% used / ${100 - window.usedPercent}% remaining`}; ${window.resetsAt === null ? 'no reset reported' : `resets ${new Date(window.resetsAt).toISOString()}`}`).join(' | ') || 'no windows'}` : 'usage unknown'}`)
    }
    if (settings.apiKeyAccountID) lines.push(`  ${label(settings.apiKeyAccountID)} — paid API key; subscription usage not applicable${sticky === settings.apiKeyAccountID ? '; sticky (saved)' : '; fallback only'}`)
  }
  return lines.join('\n')
}
