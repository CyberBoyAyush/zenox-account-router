import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { Plugin } from '@opencode/plugin'
import { afterAll } from 'vitest'
import type { ProviderID, RouterConfig, RouterState } from '../../src/types.js'

/**
 * Real OpenCode core (embedded SDK, in-memory database) with every outbound request intercepted.
 * Nothing here can reach a real provider or the user's OpenCode service.
 */
export interface Call {
  kind: 'inference' | 'usage' | 'refresh' | 'blocked'
  url: string
  authorization: string | null
  apiKey: string | null
  workspace: string | null
  model?: string
  primary: boolean
}

export type Responder = (call: Call) => Response | undefined

// The SDK's published declarations use extensionless ESM re-exports that NodeNext cannot follow,
// so the embedded host's documented shape (client + close) is declared here.
type SDK = Omit<import('@opencode/client').OpenCodeClient, 'plugin'> & { close(): Promise<void> }
interface EmbeddedSDK { create(options: Record<string, unknown>): Promise<SDK> }

export interface Credential {
  id: string
  label?: string
  /** Create without making it active (an idle backup), as OpenCode otherwise activates the newest. */
  inactive?: boolean
  value: { type: 'oauth'; methodID: string; access: string; refresh: string; expires: number; metadata?: Record<string, string> } | { type: 'key'; key: string }
}

export const now = (): number => Date.now()
export const PRIMARY_MARKER = 'PRIMARY-ROUTER-E2E'
export const MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-terra' } as const

export function oauth(provider: ProviderID, id: string, overrides: Partial<Extract<Credential['value'], { type: 'oauth' }>> = {}): Credential {
  return {
    id, label: `Synthetic ${id}`,
    value: { type: 'oauth', methodID: provider === 'anthropic' ? 'claude-max' : 'chatgpt-browser', access: `access-${id}`, refresh: `refresh-${id}`, expires: now() + 3_600_000, ...(provider === 'openai' ? { metadata: { accountID: `ws-${id}` } } : {}), ...overrides },
  }
}

export function key(id: string): Credential {
  return { id, label: `Synthetic paid ${id}`, value: { type: 'key', key: `sk-synthetic-${id}` } }
}

const anthropicEvents = (text: string): string => [
  { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

const openaiEvents = (text: string): string => {
  const item = { type: 'message', id: 'msg_e2e', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_e2e', object: 'response', created_at: 1, status: 'in_progress', model: 'm', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', sequence_number: 2, item_id: 'msg_e2e', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_e2e', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', sequence_number: 4, item_id: 'msg_e2e', output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item },
    { type: 'response.completed', sequence_number: 6, response: { id: 'resp_e2e', object: 'response', created_at: 1, status: 'completed', model: 'm', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export function success(provider: ProviderID, text: string): Response {
  return new Response(provider === 'anthropic' ? anthropicEvents(text) : openaiEvents(text), { headers: { 'content-type': 'text/event-stream' } })
}

export function weeklyQuota(provider: ProviderID): Response {
  const reset = Math.floor(now() / 1000) + 3600
  if (provider === 'anthropic') {
    return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your weekly usage limit for this plan." }, request_id: 'req_e2e_quota' }, {
      status: 429,
      headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': String(reset), 'retry-after': '3600' },
    })
  }
  return Response.json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'pro', resets_at: reset } }, { status: 429, headers: { 'x-codex-active-limit': 'codex' } })
}

export function transient(provider: ProviderID): Response {
  return provider === 'anthropic'
    ? Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests per minute exceeded. Please slow down.' } }, { status: 429, headers: { 'retry-after': '0' } })
    : Response.json({ error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 0s.' } }, { status: 429, headers: { 'retry-after': '0' } })
}

export function modelRestriction(provider: ProviderID): Response {
  return provider === 'anthropic'
    ? Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Extra usage is required for long context requests.' } }, { status: 429 })
    : Response.json({ error: { type: 'usage_not_included', message: 'This model is not included in your plan.' } }, { status: 429 })
}

export function usage(provider: ProviderID, used: number): Response {
  if (provider === 'anthropic') {
    return Response.json({
      five_hour: { utilization: used, resets_at: new Date(now() + 3_600_000).toISOString() },
      seven_day: { utilization: used, resets_at: new Date(now() + 86_400_000).toISOString() },
    })
  }
  return Response.json({ plan_type: 'pro', rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used, limit_window_seconds: 604_800, reset_at: Math.floor(now() / 1000) + 86_400 } } })
}

async function inspect(request: Request): Promise<Call> {
  const url = request.url
  const base = { url, authorization: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key'), workspace: request.headers.get('chatgpt-account-id'), primary: false }
  if (url.startsWith('https://api.anthropic.com/api/oauth/usage') || url.startsWith('https://chatgpt.com/backend-api/wham/usage')) return { ...base, kind: 'usage' }
  if (url.startsWith('https://platform.claude.com/v1/oauth/token') || url.startsWith('https://auth.openai.com/oauth/token')) return { ...base, kind: 'refresh' }
  if (url.startsWith('https://api.anthropic.com/v1/messages') || url.startsWith('https://chatgpt.com/backend-api/codex/responses') || url.startsWith('https://api.openai.com/v1/responses')) {
    const raw = Buffer.from(await request.arrayBuffer())
    const text = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw).toString() : raw.toString()
    let model: string | undefined
    try { const parsed: unknown = JSON.parse(text); if (typeof parsed === 'object' && parsed !== null && 'model' in parsed && typeof parsed.model === 'string') model = parsed.model } catch { /* non-JSON bodies are recorded without a model */ }
    const primary = model === MODELS.anthropic || model === MODELS.openai
    return { ...base, kind: 'inference', model, primary: primary && text.includes(PRIMARY_MARKER) }
  }
  return { ...base, kind: 'blocked' }
}

// OpenCode may capture `fetch` once per process, so a single delegating stub stays installed for the
// whole test file and every request without an active harness fails closed. Raw sockets to anything
// other than loopback/unix sockets are refused too, in case a dependency bypasses `fetch`.
let handler: ((request: Request) => Promise<Response>) | undefined
let installed = false
export const blockedSockets: string[] = []
function installNetworkGuards(): void {
  if (installed) return
  installed = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!handler) throw new Error('Network blocked: no active router E2E harness')
    return handler(request)
  }) as typeof fetch
  const original = Socket.prototype.connect
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
  Socket.prototype.connect = function guarded(this: Socket, ...args: unknown[]): Socket {
    const first = args[0]
    const options = typeof first === 'object' && first !== null && !Array.isArray(first) ? first as Record<string, unknown> : undefined
    const host = options ? options.host : typeof args[1] === 'string' ? args[1] : typeof first === 'number' ? 'localhost' : undefined
    const unix = options ? typeof options.path === 'string' : typeof first === 'string'
    if (!unix && typeof host === 'string' && !loopback.has(host)) {
      blockedSockets.push(host)
      throw new Error('Socket blocked by router E2E harness')
    }
    return (original as unknown as (...values: unknown[]) => Socket).apply(this, args)
  } as typeof Socket.prototype.connect
}

const LOCAL_DISCOVERY = /^http:\/\/127\.0\.0\.1:(1234|11434|8000)\//

// OpenCode resolves its data directory once per process, so later engines can recreate an earlier
// test's (already removed) directory. Remove every root again once the file finishes.
const roots = new Set<string>()
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

export interface Harness {
  sdk: SDK
  calls: Call[]
  location: { directory: string }
  statePath: string
  respond(responder: Responder): void
  active(provider: ProviderID): Promise<string | undefined>
  run(provider: ProviderID, text?: string, sessionID?: string): Promise<{ sessionID: string; text: string; failed: boolean }>
  state(): Promise<RouterState>
  primaries(provider: ProviderID): Call[]
  /** Blocked requests other than OpenCode's own loopback model-runtime discovery probes. */
  unexpected(): Call[]
  close(): Promise<void>
}

/** Credentials are created in order; the last one created is active, matching OpenCode's "newest becomes active". */
type RouterInput = Partial<Record<ProviderID, Partial<NonNullable<RouterConfig['providers'][ProviderID]>> & { accountIDs: string[] }>>

export async function start(options: { router: RouterInput; credentials: Partial<Record<ProviderID, Credential[]>>; anthropicAuth?: boolean; routerFirst?: boolean }): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'router-e2e-')))
  roots.add(root)
  // Never let real provider keys from the developer's shell leak into the embedded engine.
  for (const name of Object.keys(process.env)) if (/(?:_API_KEY|_AUTH_TOKEN)$/u.test(name) || name.startsWith('OPENCODE_')) delete process.env[name]
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    process.env[name] = join(root, name)
    await mkdir(process.env[name]!, { recursive: true })
  }
  const directory = join(root, 'work')
  await mkdir(directory)
  await mkdir(join(root, 'XDG_CONFIG_HOME', 'opencode'), { recursive: true })
  const configPath = join(root, 'XDG_CONFIG_HOME', 'opencode', 'account-router.json')
  await writeFile(configPath, JSON.stringify({ version: 1, providers: options.router }), { mode: 0o600 })
  const calls: Call[] = []
  let responder: Responder = () => undefined
  installNetworkGuards()
  handler = async request => {
    const call = await inspect(request)
    calls.push(call)
    const custom = responder(call)
    if (custom) return custom
    if (call.kind === 'blocked') throw new Error('Network blocked by router E2E harness')
    if (call.kind === 'usage') return usage(call.url.includes('anthropic') ? 'anthropic' : 'openai', 10)
    if (call.kind === 'refresh') throw new Error('Unexpected refresh in router E2E harness')
    return success(call.url.includes('anthropic') ? 'anthropic' : 'openai', 'fake success')
  }
  const previousDirectory = process.cwd()
  process.chdir(directory)
  let sdk: SDK | undefined
  const teardown = async (): Promise<void> => {
    try { await sdk?.close() } finally {
      handler = undefined
      process.chdir(previousDirectory)
      await rm(root, { recursive: true, force: true })
    }
  }
  const location = { directory }
  try {
    const OpenCode = (await import('@opencode/sdk')).OpenCode as unknown as EmbeddedSDK
    const router = (await import('../../src/index.js')).default
    // The published auth plugin is typed against an older SDK; its runtime contract is the same `{ id, setup }`.
    const auth = options.anthropicAuth === false ? [] : [(await import('@ex-machina/opencode-anthropic-auth')).default as unknown as Plugin.Plugin]
    const plugins: Plugin.Plugin[] = options.routerFirst ? [router, ...auth] : [...auth, router]
    sdk = await OpenCode.create({ app: { version: '2.2.5' }, plugins, config: { directory: join(root, 'cfg'), project: false, claude: false }, models: { fetch: false }, fs: { filewatcher: false } })
    await sdk.integration.list({ location })
    for (const provider of ['anthropic', 'openai'] as const) {
      for (const credential of options.credentials[provider] ?? []) await sdk.credential.create({ id: credential.id, integrationID: provider, label: credential.label ?? credential.id, value: credential.value, ...(credential.inactive ? { activate: false } : {}) })
    }
  } catch (error) {
    await teardown()
    throw error
  }
  const engine = sdk
  const harness: Harness = {
    sdk: engine, calls, location, statePath: join(root, 'XDG_CONFIG_HOME', 'opencode', 'account-router.state.json'),
    respond(value) { responder = value },
    async active(provider) {
      const { data } = await engine.integration.get({ integrationID: provider, location })
      const first = data.connections[0]
      return first?.type === 'credential' ? first.id : undefined
    },
    async run(provider, text = 'hello', sessionID) {
      const id = sessionID ?? (await engine.session.create({ location, model: { providerID: provider, id: MODELS[provider] } })).id
      await engine.session.prompt({ sessionID: id, text: `${PRIMARY_MARKER} ${text}` })
      await engine.experimental.session.wait({ sessionID: id })
      const messages = await engine.session.context({ sessionID: id })
      const last = [...messages].reverse().find(message => message.type === 'assistant')
      const serialized = JSON.stringify(last ?? {})
      const content = last && 'content' in last && Array.isArray(last.content) ? (last.content as unknown[]).map((part: unknown) => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : ''
      return { sessionID: id, text: content, failed: !content || /"error"|"finish":"error"/.test(serialized) }
    },
    async state() { return JSON.parse(await readFile(harness.statePath, 'utf8')) as RouterState },
    primaries(provider) { return calls.filter(call => call.kind === 'inference' && call.primary && (provider === 'anthropic' ? call.url.includes('anthropic') : !call.url.includes('anthropic'))) },
    unexpected() { return calls.filter(call => call.kind === 'blocked' && !LOCAL_DISCOVERY.test(call.url)) },
    close: teardown,
  }
  return harness
}
