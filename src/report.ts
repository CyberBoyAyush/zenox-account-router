import { cleanLabel } from './display.js'
import { PROVIDERS } from './types.js'
import type { Account, ProviderID, RouterConfig, RouterState, UsageWindow } from './types.js'

export interface ReportWindow {
  label: string
  usedPercent: number | null
  resetsAt: number | null
}

export interface ReportAccount {
  id: string
  label: string
  method: 'oauth' | 'key'
  active: boolean
  sticky: boolean
  needsAuth: boolean
  cooldownUntil?: number
  usage?: { status: string; checkedAt: number; windows: ReportWindow[] }
}

export interface ReportProvider {
  provider: ProviderID
  paidFallback: boolean
  /** Set when the active account is outside the selection, so routing is paused. */
  pausedBy?: string
  accounts: ReportAccount[]
}

export interface StatusReport {
  generatedAt: number
  pollIntervalMs: number
  live: boolean
  providers: ReportProvider[]
}

const NAMES: Record<ProviderID, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

function windows(values: UsageWindow[]): ReportWindow[] {
  // Always show the core 5-hour/weekly windows; extra (model/app) windows only once they carry data.
  const core = new Set(['five_hour', 'seven_day', 'primary', 'secondary'])
  return values
    .filter(window => (!window.model && core.has(window.id)) || window.usedPercent !== null)
    .map(window => ({ label: cleanLabel(window.label), usedPercent: window.usedPercent, resetsAt: window.resetsAt }))
}

/** Builds a credential-free status snapshot. `accounts` is the live OpenCode list when available. */
export function buildReport(config: RouterConfig, state: RouterState, options: { now: number; accounts?: Account[]; live: boolean }): StatusReport {
  const providers: ReportProvider[] = []
  for (const provider of PROVIDERS) {
    const settings = config.providers[provider]
    if (!settings) continue
    const listed = options.accounts?.filter(account => account.provider === provider)
    const active = listed?.find(account => account.active)
    const label = (id: string): string => cleanLabel(settings.accountLabels?.[id] ?? listed?.find(account => account.id === id)?.label ?? id)
    const ids = [...settings.accountIDs, ...(settings.allowPaidFallback && settings.apiKeyAccountID ? [settings.apiKeyAccountID] : [])]
    const accounts = ids.map((id): ReportAccount => {
      const account = listed?.find(item => item.id === id)
      const usage = state.usage[`${provider}:${id}`]
      const cooldown = state.cooldowns[`${provider}:${id}`]
      return {
        id, label: label(id),
        method: id === settings.apiKeyAccountID && !settings.accountIDs.includes(id) ? 'key' : 'oauth',
        active: active?.id === id,
        sticky: state.sticky[provider] === id,
        needsAuth: account?.needsAuth === true || (listed !== undefined && !account),
        ...(cooldown && cooldown.until > options.now ? { cooldownUntil: cooldown.until } : {}),
        ...(usage ? { usage: { status: usage.status, checkedAt: usage.checkedAt, windows: windows(usage.windows) } } : {}),
      }
    })
    providers.push({
      provider, paidFallback: settings.allowPaidFallback, accounts,
      ...(active && !ids.includes(active.id) ? { pausedBy: cleanLabel(active.label) } : {}),
    })
  }
  return { generatedAt: options.now, pollIntervalMs: config.pollIntervalMs, live: options.live, providers }
}

export function duration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function ago(milliseconds: number): string {
  const value = duration(milliseconds)
  return value === 'now' ? 'just now' : `${value} ago`
}

function bar(percent: number, width = 14): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length)
}

/** Plain-text rendering shared by the OpenCode dialog and the CLI. */
export function formatReport(report: StatusReport): string {
  if (!report.providers.length) return 'No providers are configured. Run `npx zenox-account-router setup`.'
  const now = report.generatedAt
  const lines: string[] = []
  for (const provider of report.providers) {
    if (lines.length) lines.push('')
    lines.push(`${NAMES[provider.provider]} · paid fallback ${provider.paidFallback ? 'ON' : 'off'}`)
    if (provider.pausedBy) lines.push(`  Routing paused: active account "${provider.pausedBy}" is not in your selection.`)
    for (const account of provider.accounts) {
      const tags = [
        account.active ? 'ACTIVE' : undefined,
        account.sticky && !account.active ? 'sticky' : undefined,
        account.cooldownUntil ? `cooling down ${duration(account.cooldownUntil - now)}` : undefined,
        account.needsAuth ? 'needs sign-in' : undefined,
        account.method === 'key' ? 'paid API key' : undefined,
      ].filter((tag): tag is string => !!tag)
      lines.push(`${account.active ? '●' : '○'} ${account.label}${tags.length ? `  [${tags.join(' · ')}]` : account.method === 'oauth' ? '  [standby]' : ''}`)
      if (account.method === 'key') continue
      const usage = account.usage
      if (!usage) { lines.push('    usage not checked yet'); continue }
      if (usage.status !== 'ok') {
        const reason: Record<string, string> = { expired: 'token expired (refreshed when needed)', 'needs-auth': 'needs sign-in', 'rate-limited': 'usage check rate-limited', unavailable: 'usage unavailable', unsupported: 'not applicable' }
        lines.push(`    ${reason[usage.status] ?? usage.status} · checked ${ago(now - usage.checkedAt)}`)
        continue
      }
      const labelWidth = Math.max(8, ...usage.windows.map(window => window.label.length))
      for (const window of usage.windows) {
        const percent = window.usedPercent
        const reset = window.resetsAt === null ? (percent === null || percent === 0 ? 'not started' : 'no reset reported') : window.resetsAt <= now ? 'resetting' : `resets in ${duration(window.resetsAt - now)}`
        lines.push(`    ${pad(window.label, labelWidth)} ${percent === null ? pad('unknown', 14) : bar(percent)} ${percent === null ? '' : `${pad(`${Math.round(percent)}%`, 4)} used · `}${reset}`)
      }
      lines.push(`    checked ${ago(now - usage.checkedAt)}`)
    }
  }
  lines.push('')
  lines.push(`Usage refreshes every ${duration(report.pollIntervalMs)} while you're active. ${report.live ? '' : 'Saved snapshot; use --refresh for live data.'}`.trim())
  return lines.join('\n')
}
