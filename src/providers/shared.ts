import type { ProviderID, StoredCredential, UsageSnapshot } from '../types.js'

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function epoch(value: unknown): number | undefined {
  return finite(value) && value > 0 && value <= 8.64e12 ? value * 1000 : undefined
}

export function percent(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  return finite(value) && value >= 0 && value <= 100 ? value : undefined
}

export function safeHeader(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value)
}

export function snapshot(provider: ProviderID, credential: StoredCredential, now: number, status: UsageSnapshot['status']): UsageSnapshot {
  return { provider, accountID: credential.id, checkedAt: now, status, windows: [] }
}

export function credentialStatus(credential: StoredCredential, now: number): UsageSnapshot['status'] | undefined {
  if (credential.method !== 'oauth') return 'unsupported'
  if (credential.needsAuth || !safeHeader(credential.access)) return 'needs-auth'
  if (credential.expiresAt !== undefined && (!finite(credential.expiresAt) || credential.expiresAt <= now)) return 'expired'
  return undefined
}

/** A monitoring 429 never proves that inference allowance is exhausted. */
export function checkRetryAfter(headers: Headers, now: number): number {
  const raw = headers.get('retry-after')
  let delay = 0
  if (raw !== null) {
    if (/^\d+(?:\.\d+)?$/.test(raw.trim())) delay = Number(raw) * 1000
    else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) delay = parsed - now
    }
  }
  return now + Math.min(86_400_000, Math.max(600_000, delay))
}

export async function readBoundedJson(
  response: Response,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<unknown | undefined> {
  const maxBytes = finite(options.maxBytes) ? Math.min(128 * 1024, Math.max(0, options.maxBytes)) : 128 * 1024
  const timeoutMs = finite(options.timeoutMs) ? Math.min(10_000, Math.max(0, options.timeoutMs)) : 10_000
  if (!response.body || response.body.locked) return undefined
  const reader = response.body.getReader()
  const expired = Symbol('expired')
  let expire: (() => void) | undefined
  const deadline = new Promise<typeof expired>(resolve => { expire = () => resolve(expired) })
  const timer = setTimeout(() => expire?.(), timeoutMs)
  const abort = () => expire?.()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let complete = false
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    let count = 0
    while (true) {
      const result = await Promise.race([reader.read(), deadline])
      if (result === expired) return undefined
      if (result.done) { complete = true; break }
      if (++count > 1024) return undefined
      length += result.value.byteLength
      if (length > maxBytes) return undefined
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function getUsage(
  url: string, headers: Headers, options: { fetch: typeof fetch; signal?: AbortSignal },
): Promise<{ status: number; headers: Headers; body: unknown } | undefined> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let expire: (() => void) | undefined
  const deadline = new Promise<undefined>(resolve => { expire = () => { controller.abort(); resolve(undefined) } })
  const timer = setTimeout(() => expire?.(), 10_000)
  const abort = () => expire?.()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) return undefined
    return await Promise.race([
      (async () => {
        const response = await options.fetch(url, { method: 'GET', headers, redirect: 'error', credentials: 'omit', signal })
        const body = response.ok ? await readBoundedJson(response, { signal }) : undefined
        if (!response.ok && response.body) void response.body.cancel().catch(() => undefined)
        return { status: response.status, headers: response.headers, body }
      })(),
      deadline,
    ])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function usageFailure(provider: ProviderID, credential: StoredCredential, now: number, response: Awaited<ReturnType<typeof getUsage>>): UsageSnapshot | undefined {
  if (response && response.status >= 200 && response.status < 300) return undefined
  const result = snapshot(provider, credential, now, response?.status === 401 || response?.status === 403 ? 'needs-auth' : response?.status === 429 ? 'rate-limited' : 'unavailable')
  if (response?.status === 429) result.retryAt = checkRetryAfter(response.headers, now)
  return result
}

export function errorObjects(body: unknown): Record<string, unknown>[] {
  const root = record(body)
  if (!root) return []
  const nestedBody = record(root.body)
  return [record(root.error), record(nestedBody?.error), nestedBody, root].filter((value): value is Record<string, unknown> => value !== undefined)
}

export function trustedURL(request: Request, origin: string): URL | undefined {
  try {
    const url = new URL(request.url)
    return url.origin === origin && !url.username && !url.password ? url : undefined
  } catch { return undefined }
}

export function bearerMatches(credential: StoredCredential, request: Request): boolean {
  const token = credential.method === 'oauth' ? credential.access : credential.key
  return safeHeader(token) && request.headers.get('authorization') === `Bearer ${token}`
}
