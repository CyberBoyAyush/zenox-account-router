import { stripVTControlCharacters } from 'node:util'
import type { RouterDecision, UsageSnapshot } from './types.js'

export function cleanLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 160)
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

/** Compact usage summary for the log, e.g. `5-hour 14% (resets in 3h 42m) · Weekly 30% (resets in 4d 20h)`. */
export function describeUsage(usage: UsageSnapshot, now: number): string {
  if (usage.status !== 'ok') {
    const status: Record<string, string> = {
      expired: 'sign-in token expired (OpenCode refreshes it when the account is needed)',
      'needs-auth': 'needs sign-in (run /connect in OpenCode)',
      'rate-limited': 'usage check was rate-limited by the provider',
      unavailable: 'usage check failed or returned something unreadable',
      unsupported: 'usage is not reported for this account',
    }
    const retry = usage.retryAt && usage.retryAt > now ? `; next try in ${duration(usage.retryAt - now)}` : ''
    return `${status[usage.status] ?? usage.status}${retry}`
  }
  const parts = usage.windows
    .filter(window => !window.model && window.usedPercent !== null)
    .map(window => `${cleanLabel(window.label)} ${Math.round(window.usedPercent!)}% (${window.resetsAt === null ? 'not started' : window.resetsAt <= now ? 'just reset' : `resets in ${duration(window.resetsAt - now)}`})`)
  if (usage.allowed === false) parts.push('provider reports the limit is reached')
  return parts.length ? parts.join(' · ') : 'no usage windows reported'
}

const two = (value: number): string => String(value).padStart(2, '0')

/** Local wall-clock time with its UTC offset, e.g. `2026-11-03 22:41:05.123 +05:30`. */
export function localTimestamp(at: number): string {
  const date = new Date(at)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')} ${zone}`
}

/** Last line of defence for the log: anything shaped like a token or key is replaced. */
export function scrubSecrets(value: string): string {
  return value
    .replace(/\b(bearer|basic)\s+[^\s|]+/giu, '$1 [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu, '[redacted]')
    // Long opaque runs with digits (raw tokens); paths and hyphenated names stay readable.
    .replace(/(?<![A-Za-z0-9+_-])(?=[A-Za-z+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}/gu, '[redacted]')
}

/** One credential-free line of the decision log: `time | LEVEL | scope | EVENT | accounts | message`. */
export function formatDecision(decision: RouterDecision): string {
  const accounts = decision.from && decision.to ? `${cleanLabel(decision.from)} → ${cleanLabel(decision.to)}` : cleanLabel(decision.to ?? decision.from ?? '')
  const level = (decision.level ?? 'info').toUpperCase().padEnd(5)
  // Scrub before shortening, so a token is never cut into a piece the patterns no longer recognise.
  const reason = scrubSecrets(stripVTControlCharacters(decision.reason).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')).slice(0, 1_000)
  return scrubSecrets([localTimestamp(decision.at), level, decision.provider, decision.event.toUpperCase(), accounts || '-', reason].join(' | '))
}
