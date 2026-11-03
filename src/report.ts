import { cleanLabel, duration } from './display.js'
import { chooseInitial, DEFAULT_CACHE_WINDOW_MS, planRebalance } from './policy.js'
import { PROVIDERS } from './types.js'
import type { Account, ProviderID, RouterConfig, RouterState, RoutingStrategy, UsageWindow } from './types.js'

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
  favorite: boolean
  needsAuth: boolean
  cooldownUntil?: number
  usage?: { status: string; checkedAt: number; windows: ReportWindow[] }
}

export interface ReportProvider {
  provider: ProviderID
  paidFallback: boolean
  /** Set when the active account is outside the selection, so routing is paused. */
  pausedBy?: string
  /** Where the router would go if the current account ran out; `null` means it would stop. */
  next: { label: string; paid: boolean } | null
  /** Smart routing only: the account the next cache-safe prompt would move to. */
  better?: { label: string; reason: string }
  accounts: ReportAccount[]
}

export interface StatusReport {
  generatedAt: number
  pollIntervalMs: number
  strategy: RoutingStrategy
  /** Effective prompt-cache window per configured provider. */
  cacheWindows: Partial<Record<ProviderID, number>>
  /** Where the decision log is written, when known. */
  logPath?: string
  live: boolean
  /** True when the OpenCode account list was read, so `active` reflects OpenCode itself. */
  liveAccounts: boolean
  providers: ReportProvider[]
}

export const PROVIDER_NAMES: Record<ProviderID, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

function windows(values: UsageWindow[]): ReportWindow[] {
  // Always show the core 5-hour/weekly windows; extra (model/app) windows only once they carry data.
  const core = new Set(['five_hour', 'seven_day', 'primary', 'secondary'])
  return values
    .filter(window => (!window.model && core.has(window.id)) || window.usedPercent !== null)
    .map(window => ({ label: cleanLabel(window.label), usedPercent: window.usedPercent, resetsAt: window.resetsAt }))
}

/** Builds a credential-free status snapshot. `accounts` is the live OpenCode list when available. */
export function buildReport(config: RouterConfig, state: RouterState, options: { now: number; accounts?: Account[]; live: boolean; cacheWindows?: Partial<Record<ProviderID, number>>; logPath?: string }): StatusReport {
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
        favorite: settings.favoriteAccountID === id,
        needsAuth: account?.needsAuth === true || (listed !== undefined && !account),
        ...(cooldown && cooldown.until > options.now ? { cooldownUntil: cooldown.until } : {}),
        ...(usage ? { usage: { status: usage.status, checkedAt: usage.checkedAt, windows: windows(usage.windows) } } : {}),
      }
    })
    const current = listed ? active?.id : state.sticky[provider]
    const alternatives = accounts
      .filter(account => account.method === 'oauth' && account.id !== current && !account.needsAuth && !account.cooldownUntil)
      .map((account): Account => ({ id: account.id, provider, label: account.label, method: 'oauth', active: false }))
    const choice = chooseInitial(settings, alternatives, Object.values(state.usage), options.now, config.strategy).accountID
    // Mirrors the controller: the key is only used once every selected subscription is signed in and exhausted.
    const key = accounts.find(account => account.method === 'key')
    const keyUsable = !!key && key.id !== current && !key.needsAuth && !key.cooldownUntil && accounts.every(account => account.method === 'key' || !account.needsAuth)
    const using = accounts.find(account => account.id === current && account.method === 'oauth' && !account.needsAuth)
    const plan = config.strategy === 'smart' && using
      ? planRebalance(settings, { id: using.id, provider, label: using.label, method: 'oauth', active: true }, alternatives, Object.values(state.usage), options.now, { maxAge: config.pollIntervalMs, currentBlocked: !!using.cooldownUntil })
      : undefined
    providers.push({
      provider, paidFallback: settings.allowPaidFallback, accounts,
      next: choice ? { label: label(choice), paid: false } : keyUsable ? { label: key.label, paid: true } : null,
      ...(plan?.accountID ? { better: { label: label(plan.accountID), reason: plan.reason } } : {}),
      ...(active && !ids.includes(active.id) ? { pausedBy: cleanLabel(active.label) } : {}),
    })
  }
  const cacheWindows: Partial<Record<ProviderID, number>> = {}
  for (const { provider } of providers) cacheWindows[provider] = options.cacheWindows?.[provider] ?? config.cacheWindowMs ?? DEFAULT_CACHE_WINDOW_MS[provider]
  return { generatedAt: options.now, pollIntervalMs: config.pollIntervalMs, strategy: config.strategy, cacheWindows, ...(options.logPath ? { logPath: options.logPath } : {}), live: options.live, liveAccounts: options.accounts !== undefined, providers }
}

export { duration }

function ago(milliseconds: number): string {
  const value = duration(milliseconds)
  return value === 'now' ? 'just now' : `${value} ago`
}

/** Semantic colour roles; the CLI maps them to ANSI and the OpenCode dialog to theme colours. */
export type Tone = 'text' | 'strong' | 'muted' | 'faint' | 'accent' | 'good' | 'warn' | 'bad'
export interface Segment { text: string; tone?: Tone }
export type Line = Segment[]

export const BAR_WIDTH = 20
const LABEL_WIDTH = 36

export function usageTone(percent: number): Tone {
  return percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'good'
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WIDE = /\p{Extended_Pictographic}|[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u

/** Terminal columns: CJK and emoji take two, combining sequences one. */
export function displayWidth(value: string): number {
  let width = 0
  for (const { segment } of graphemes.segment(value)) width += WIDE.test(segment) ? 2 : 1
  return width
}

/** Pads or truncates (with …) to exactly `width` columns without splitting characters. */
export function fit(value: string, width: number): string {
  if (displayWidth(value) <= width) return value + ' '.repeat(width - displayWidth(value))
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(value)) {
    const size = WIDE.test(segment) ? 2 : 1
    if (used + size > width - 1) break
    out += segment
    used += size
  }
  return `${out}…${' '.repeat(width - 1 - used)}`
}

function joinTags(tags: Segment[]): Line {
  return tags.flatMap((tag, index) => (index ? [{ text: ' · ', tone: 'faint' as const }, tag] : [tag]))
}

/**
 * Lays the report out as styled lines (≤ 80 columns). `title` adds a heading for standalone output;
 * `cli` adds hints that only make sense on the command line.
 */
export function layoutReport(report: StatusReport, options: { title?: boolean; cli?: boolean } = {}): Line[] {
  const lines: Line[] = []
  const now = report.generatedAt
  if (options.title) {
    lines.push([{ text: 'Zenox Account Router', tone: 'strong' }, { text: report.live ? '  ·  live' : '  ·  saved snapshot', tone: 'muted' }])
    lines.push([])
  }
  if (!report.providers.length) {
    lines.push([{ text: 'No providers are configured yet. Run ', tone: 'text' }, { text: 'npx zenox-account-router setup', tone: 'accent' }, { text: '.', tone: 'text' }])
    return lines
  }
  const labelWidth = Math.max(6, ...report.providers.flatMap(provider => provider.accounts.flatMap(account => account.usage?.windows.map(window => window.label.length) ?? [])))
  for (const [index, provider] of report.providers.entries()) {
    if (index) lines.push([])
    lines.push([
      { text: PROVIDER_NAMES[provider.provider].toUpperCase(), tone: 'accent' },
      { text: '   paid fallback ', tone: 'muted' },
      { text: provider.paidFallback ? 'ON' : 'off', tone: provider.paidFallback ? 'warn' : 'muted' },
    ])
    if (provider.pausedBy) lines.push([{ text: `  ! Paused: "${fit(provider.pausedBy, 30).trimEnd()}" is active but not selected.`, tone: 'warn' }])
    for (const account of provider.accounts) {
      // Without OpenCode's live list, the account the router last activated is the best guess at "in use".
      const inUse = report.liveAccounts ? account.active : account.sticky
      const tags: Segment[] = []
      if (inUse) tags.push({ text: report.liveAccounts ? 'ACTIVE' : 'IN USE', tone: 'good' })
      if (account.cooldownUntil) tags.push({ text: `limit hit · back in ${duration(account.cooldownUntil - now)}`, tone: 'warn' })
      if (account.needsAuth) tags.push({ text: 'needs sign-in', tone: 'bad' })
      if (account.method === 'key') tags.push({ text: 'paid API key · last resort', tone: 'warn' })
      if (!tags.length) tags.push({ text: 'standby', tone: 'muted' })
      if (account.favorite) tags.push({ text: '★ favorite', tone: 'muted' })
      // Tags that would push the line past 80 columns continue on an indented line.
      const room = 80 - (LABEL_WIDTH + 5)
      let used = 0
      const overflow = tags.findIndex((tag, index) => (used += displayWidth(tag.text) + (index ? 3 : 0)) > room)
      const split = overflow === -1 ? -1 : Math.max(1, overflow)
      const first = split > 0 ? tags.slice(0, split) : tags
      lines.push([
        { text: '  ' },
        { text: inUse ? '●' : '○', tone: inUse ? 'good' : 'faint' },
        { text: ` ${fit(account.label, LABEL_WIDTH)} `, tone: inUse ? 'strong' : 'text' },
        ...joinTags(first),
      ])
      if (split > 0) lines.push([{ text: '      ' }, ...joinTags(tags.slice(split))])
      if (account.method === 'key') continue
      const usage = account.usage
      if (!usage) { lines.push([{ text: '      usage not checked yet', tone: 'faint' }]); continue }
      if (usage.status !== 'ok') {
        const reason: Record<string, [string, Tone]> = {
          expired: ['sign-in token expired · OpenCode refreshes it when this account is used', 'muted'],
          'needs-auth': ['needs sign-in · run /connect in OpenCode', 'bad'],
          'rate-limited': ['usage check rate-limited · will retry', 'warn'],
          unavailable: ['usage unavailable right now', 'warn'],
          unsupported: ['usage not reported for this account', 'muted'],
        }
        const [text, tone] = reason[usage.status] ?? [usage.status, 'muted']
        lines.push([{ text: `      ${text}`, tone }, { text: ` · ${ago(now - usage.checkedAt)}`, tone: 'faint' }])
        continue
      }
      for (const window of usage.windows) {
        const percent = window.usedPercent
        const reset = window.resetsAt === null ? (percent === null || percent === 0 ? 'not started' : 'no reset time') : window.resetsAt <= now ? 'reset since this check' : `resets in ${duration(window.resetsAt - now)}`
        if (percent === null) {
          lines.push([{ text: `      ${window.label.padEnd(labelWidth)}  `, tone: 'muted' }, { text: '·'.repeat(BAR_WIDTH), tone: 'faint' }, { text: '     ?  ', tone: 'faint' }, { text: reset, tone: 'faint' }])
          continue
        }
        const clamped = Math.min(100, Math.max(0, percent))
        const filled = Math.round((clamped / 100) * BAR_WIDTH)
        const tone = usageTone(clamped)
        lines.push([
          { text: `      ${window.label.padEnd(labelWidth)}  `, tone: 'muted' },
          { text: '█'.repeat(filled), tone },
          { text: '░'.repeat(BAR_WIDTH - filled), tone: 'faint' },
          { text: `  ${`${Math.round(clamped)}%`.padStart(4)}  `, tone },
          { text: reset, tone: 'muted' },
        ])
      }
      lines.push([{ text: `      checked ${ago(now - usage.checkedAt)}`, tone: 'faint' }])
    }
    if (provider.accounts.filter(account => account.method === 'oauth').length > 1 || provider.next?.paid) {
      lines.push([
        { text: '  → If the current account runs out: ', tone: 'muted' },
        provider.next ? { text: provider.next.paid ? `${fit(provider.next.label, 20).trimEnd()} (paid, allowed models)` : fit(provider.next.label, 42).trimEnd(), tone: provider.next.paid ? 'warn' : 'text' } : { text: 'nothing left, requests stop', tone: 'bad' },
      ])
    }
    if (provider.better) lines.push([{ text: '  → Next quiet prompt moves to: ', tone: 'muted' }, { text: fit(provider.better.label, 44).trimEnd(), tone: 'good' }])
  }
  lines.push([])
  lines.push([{ text: `Usage is checked every ${duration(report.pollIntervalMs)} while OpenCode is active.`, tone: 'faint' }])
  if (report.strategy === 'smart') {
    const windows = report.providers.map(provider => `${duration(report.cacheWindows[provider.provider] ?? DEFAULT_CACHE_WINDOW_MS[provider.provider])}${report.providers.length > 1 ? ` ${PROVIDER_NAMES[provider.provider]}` : ''}`).join(', ')
    lines.push([{ text: `Smart routing: once the prompt cache has expired (${windows} with`, tone: 'faint' }])
    lines.push([{ text: 'no requests), a prompt moves to the account whose allowance expires', tone: 'faint' }])
    lines.push([{ text: 'first. Mid-conversation it switches only when an account runs out.', tone: 'faint' }])
  } else lines.push([{ text: 'The router switches accounts only when one runs out.', tone: 'faint' }])
  if (report.logPath) {
    // Keep the end of a long path: the file name matters more than the start.
    const path = report.logPath.replace(/^\/(?:Users|home)\/[^/]+/u, '~')
    lines.push([{ text: 'Log: ', tone: 'faint' }, { text: displayWidth(path) > 74 ? `…${path.slice(-73)}` : path, tone: 'faint' }])
  }
  if (options.cli && !report.live) lines.push([{ text: 'Saved snapshot. Add --refresh for live numbers.', tone: 'faint' }])
  return lines
}

/** Renders laid-out lines; `paint` styles one segment (identity for plain text). */
export function renderLines(lines: Line[], paint: (segment: Segment) => string = segment => segment.text): string {
  return lines.map(line => line.map(paint).join('').trimEnd()).join('\n')
}

/** Plain-text rendering, used by the dialog fallback and plain CLI output. */
export function formatReport(report: StatusReport, options?: { title?: boolean; cli?: boolean }): string {
  return renderLines(layoutReport(report, options))
}
