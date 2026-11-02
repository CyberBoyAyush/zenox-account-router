import type { ProviderAdapter, QuotaEvidence, UsageWindow } from '../types.js'
import { bearerMatches, credentialStatus, epoch, errorObjects, getUsage, percent, record, safeHeader, snapshot, trustedURL, usageFailure } from './shared.js'

const windowFields = [
  ['five_hour', '5-hour', 18_000, undefined],
  ['seven_day', 'Weekly', 604_800, undefined],
  ['seven_day_oauth_apps', 'OAuth apps weekly', 604_800, undefined],
  ['seven_day_opus', 'Opus weekly', 604_800, 'opus'],
  ['seven_day_sonnet', 'Sonnet weekly', 604_800, 'sonnet'],
] as const

function parseWindows(body: unknown): UsageWindow[] | undefined {
  const root = record(body)
  if (!root || !windowFields.some(([id]) => Object.hasOwn(root, id))) return undefined
  const windows: UsageWindow[] = []
  for (const [id, label, durationSeconds, model] of windowFields) {
    if (!Object.hasOwn(root, id)) continue
    const raw = root[id]
    const value = record(raw)
    if (raw !== undefined && raw !== null && !value) return undefined
    const usedPercent = percent(value?.utilization)
    if (usedPercent === undefined) return undefined
    const reset = value?.resets_at
    let resetsAt: number | null = null
    if (reset !== undefined && reset !== null) {
      if (typeof reset !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(reset)) return undefined
      resetsAt = Date.parse(reset)
      if (!Number.isFinite(resetsAt)) return undefined
    }
    windows.push({ id, label, durationSeconds, usedPercent, resetsAt, ...(model ? { model } : {}) })
  }
  return windows
}

function classify(status: number, headers: Headers, body: unknown): QuotaEvidence {
  if (status === 401 || status === 403) return { kind: 'auth', scope: 'account' }
  const errors = errorObjects(body)
  const text = errors.map(value => typeof value.message === 'string' ? value.message.slice(0, 4096) : '').join(' ').toLowerCase()
  const types = errors.flatMap(value => [value.type, value.code]).filter((value): value is string => typeof value === 'string')
  if (/extra[ _-]?usage|long[ _-]?context|fast[ _-]?mode|\b(?:opus|sonnet|haiku)\b|\bmodel(?:-specific| restriction| usage| limit| unavailable| is not| not supported)/.test(text) || types.some(value => /extra_usage|long_context|fast_mode|usage_not_included|model_restriction/.test(value))) {
    return { kind: 'model-restriction', scope: 'model' }
  }
  // An API key with an empty prepaid balance is rejected with 400 (or 402 billing_error), never 429.
  if (/credit balance is too low/.test(text) || types.includes('billing_error')) return { kind: 'quota', scope: 'account', code: 'credit_balance' }
  if (status !== 429) return { kind: 'unknown', scope: 'account' }
  if (/requests? per minute|tokens? per minute|\brpm\b|\btpm\b|too many requests|rate limit per/.test(text)) return { kind: 'transient', scope: 'account' }
  const rejected: number[] = []
  let hasRejected = false
  for (const window of ['5h', '7d']) {
    const prefix = `anthropic-ratelimit-unified-${window}`
    if (headers.get(`${prefix}-status`) !== 'rejected') continue
    hasRejected = true
    const raw = headers.get(`${prefix}-reset`)
    const reset = raw !== null ? epoch(Number(raw)) : undefined
    if (reset !== undefined) rejected.push(reset)
  }
  if (hasRejected) return { kind: 'quota', scope: 'account', ...(rejected.length ? { resetAt: Math.max(...rejected) } : {}) }
  const allowance = /(?:weekly|session|subscription|plan|five.hour|5.hour|seven.day|7.day).{0,100}(?:limit|allowance|quota).{0,60}(?:reach|exceed|exhaust)|(?:reach|exceed|exhaust).{0,100}(?:weekly|session|subscription|plan|five.hour|5.hour|seven.day|7.day).{0,80}(?:limit|allowance|quota)/.test(text)
  if (allowance || /(?:weekly|session|subscription|plan)_(?:usage_)?limit_(?:reached|exceeded)/.test(types.join(' '))) return { kind: 'quota', scope: 'account' }
  // The OAuth plugin's canonical subscription diagnostic is not a generic 429.
  if (/you have reached your claude usage limit/.test(text)) return { kind: 'quota', scope: 'account', code: 'subscription_usage_limit' }
  return { kind: 'transient', scope: 'account' }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  async readUsage(credential, options) {
    if (credential.provider !== 'anthropic') return snapshot('anthropic', credential, options.now, 'unsupported')
    const status = credentialStatus(credential, options.now)
    if (status) return snapshot('anthropic', credential, options.now, status)
    const headers = new Headers({ Authorization: `Bearer ${credential.access}`, Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' })
    const response = await getUsage('https://api.anthropic.com/api/oauth/usage', headers, options)
    const failure = usageFailure('anthropic', credential, options.now, response)
    if (failure) return failure
    const windows = parseWindows(response?.body)
    if (!windows) return snapshot('anthropic', credential, options.now, 'unavailable')
    return { ...snapshot('anthropic', credential, options.now, 'ok'), windows }
  },
  classify,
  matchesRequest(credential, request) {
    if (credential.provider !== 'anthropic') return false
    const url = trustedURL(request, 'https://api.anthropic.com')
    if (!url || !(url.pathname === '/v1/messages' || url.pathname.startsWith('/v1/messages/'))) return false
    if (credential.method === 'oauth') return bearerMatches(credential, request)
    return safeHeader(credential.key) && request.headers.get('x-api-key') === credential.key
  },
}
