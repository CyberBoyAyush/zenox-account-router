import type { ProviderAdapter, QuotaEvidence, StoredCredential, UsageWindow } from '../types.js'
import { bearerMatches, credentialStatus, epoch, errorObjects, finite, getUsage, percent, record, safeHeader, snapshot, trustedURL, usageFailure } from './shared.js'

function jwtClaims(credential: StoredCredential): Record<string, unknown> | undefined {
  const access = credential.access
  if (!access || access.length > 16_384) return undefined
  const segments = access.split('.')
  if (segments.length !== 3 || segments.some(segment => !segment)) return undefined
  const payload = segments[1]
  if (!payload || payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown)
  } catch { return undefined }
}

function accountID(credential: StoredCredential): { value?: string; invalid?: boolean } {
  for (const key of ['accountID', 'account_id', 'chatgpt_account_id']) {
    const value = credential.metadata?.[key]
    if (value !== undefined && value !== null) return safeHeader(value) && value.length <= 2048 ? { value } : { invalid: true }
  }
  const root = jwtClaims(credential)
  const auth = record(root?.['https://api.openai.com/auth'])
  const value = auth?.chatgpt_account_id ?? root?.chatgpt_account_id
  return value === undefined || value === null ? {} : safeHeader(value) && value.length <= 2048 ? { value } : { invalid: true }
}

function fedrampHint(credential: StoredCredential): boolean | undefined {
  const root = jwtClaims(credential)
  const auth = record(root?.['https://api.openai.com/auth'])
  const value = credential.metadata?.chatgpt_account_is_fedramp ?? credential.metadata?.is_fedramp ?? credential.metadata?.isFedramp ?? auth?.chatgpt_account_is_fedramp ?? root?.chatgpt_account_is_fedramp
  return typeof value === 'boolean' ? value : undefined
}

function parseWindow(value: unknown, slot: string, now: number, model?: string): UsageWindow | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const usedPercent = percent(raw.used_percent)
  if (usedPercent === undefined) return undefined
  const duration = raw.limit_window_seconds
  if (duration !== undefined && (!finite(duration) || duration <= 0 || !Number.isInteger(duration))) return undefined
  const reset = raw.reset_at
  const relativeReset = raw.reset_after_seconds
  if (relativeReset !== undefined && relativeReset !== null && (!finite(relativeReset) || relativeReset < 0 || relativeReset > 86_400 * 365)) return undefined
  const resetsAt = reset === undefined || reset === null ? finite(relativeReset) ? now + relativeReset * 1000 : null : epoch(reset)
  if (resetsAt === undefined) return undefined
  const kind = duration === 18_000 ? 'five_hour' : duration === 604_800 ? 'seven_day' : slot
  const label = duration === 18_000 ? '5-hour' : duration === 604_800 ? 'Weekly' : slot === 'primary' ? 'Primary' : 'Secondary'
  return { id: model ? `${model}:${kind}` : kind, label, usedPercent, resetsAt, ...(finite(duration) ? { durationSeconds: duration } : {}), ...(model ? { model } : {}) }
}

function parseRateLimit(value: unknown, now: number, model?: string): { windows: UsageWindow[]; allowed?: boolean } | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (raw.allowed !== undefined && typeof raw.allowed !== 'boolean') return undefined
  if (raw.limit_reached !== undefined && typeof raw.limit_reached !== 'boolean') return undefined
  const windows: UsageWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const window = raw[`${slot}_window`]
    if (window === undefined || window === null) continue
    const parsed = parseWindow(window, slot, now, model)
    if (!parsed) return undefined
    windows.push(parsed)
  }
  if (!windows.length && raw.allowed === undefined && raw.limit_reached === undefined) return undefined
  const allowed = raw.limit_reached === true || raw.allowed === false ? false : raw.allowed === true || raw.limit_reached === false ? true : undefined
  return { windows, ...(allowed !== undefined ? { allowed } : {}) }
}

function modelScope(value: Record<string, unknown>): string | undefined {
  const model = value.normal_model_slug ?? value.model ?? value.model_slug ?? value.limit_name
  if (typeof model !== 'string' || model.length > 80) return undefined
  const normalized = model.toLowerCase()
  return /^(?:gpt-[a-z0-9.-]+|o[134](?:-[a-z0-9.-]+)?|codex-[a-z0-9.-]+)$/.test(normalized) ? normalized : undefined
}

function classify(status: number, _headers: Headers, body: unknown, now: number): QuotaEvidence {
  if (status === 401 || status === 403) return { kind: 'auth', scope: 'account' }
  for (const error of errorObjects(body)) {
    const codes = [error.type, error.code]
    if (codes.includes('usage_not_included')) return { kind: 'model-restriction', scope: 'model', code: 'usage_not_included' }
    const billing = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].find(code => codes.includes(code))
    if (billing) return { kind: 'quota', scope: 'account', code: billing }
    if (codes.includes('usage_limit_reached')) {
      const absolute = epoch(error.resets_at)
      const seconds = error.resets_in_seconds
      const relative = finite(seconds) && seconds > 0 && seconds <= 86_400 * 365 ? now + seconds * 1000 : undefined
      const resetAt = absolute && absolute > now ? absolute : relative
      return { kind: 'quota', scope: 'account', code: 'usage_limit_reached', ...(resetAt !== undefined ? { resetAt } : {}) }
    }
    for (const code of ['turn_rate_limit_exceeded', 'rate_limit_exceeded', 'slow_down']) {
      if (codes.includes(code)) return { kind: 'transient', scope: 'account', code }
    }
  }
  return { kind: status === 429 ? 'transient' : 'unknown', scope: 'account' }
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  async readUsage(credential, options) {
    if (credential.provider !== 'openai') return snapshot('openai', credential, options.now, 'unsupported')
    const status = credentialStatus(credential, options.now)
    if (status) return snapshot('openai', credential, options.now, status)
    const account = accountID(credential)
    if (account.invalid) return snapshot('openai', credential, options.now, 'unavailable')
    const headers = new Headers({ Authorization: `Bearer ${credential.access}`, Accept: 'application/json', 'User-Agent': 'zenox-account-router' })
    if (account.value) headers.set('ChatGPT-Account-Id', account.value)
    const fedramp = fedrampHint(credential)
    if (fedramp === true) headers.set('X-OpenAI-Fedramp', 'true')
    const response = await getUsage('https://chatgpt.com/backend-api/wham/usage', headers, options)
    const failure = usageFailure('openai', credential, options.now, response)
    if (failure) return failure
    const root = record(response?.body)
    const parsed = parseRateLimit(root?.rate_limit, options.now)
    if (!root || !parsed) return snapshot('openai', credential, options.now, 'unavailable')
    if (Array.isArray(root.additional_rate_limits)) {
      for (const value of root.additional_rate_limits.slice(0, 8)) {
        const additional = record(value)
        const model = additional && modelScope(additional)
        if (!additional || !model) continue
        const rate = parseRateLimit(additional.rate_limit, options.now, model)
        if (rate) parsed.windows.push(...rate.windows)
      }
    }
    const plan = typeof root.plan_type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(root.plan_type) ? root.plan_type : undefined
    return { ...snapshot('openai', credential, options.now, 'ok'), ...parsed, ...(plan ? { plan } : {}) }
  },
  classify,
  matchesRequest(credential, request) {
    if (credential.provider !== 'openai') return false
    const api = trustedURL(request, 'https://api.openai.com')
    const chat = trustedURL(request, 'https://chatgpt.com')
    if (!(api && api.pathname.startsWith('/v1/')) && !(chat && chat.pathname === '/backend-api/codex/responses')) return false
    if (!bearerMatches(credential, request)) return false
    if (credential.method === 'oauth') {
      const account = accountID(credential)
      if (account.invalid || (account.value && request.headers.get('ChatGPT-Account-Id') !== account.value)) return false
    }
    return true
  },
}
