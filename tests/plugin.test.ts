import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { defaultConfig, defaultStatePath, parseConfig } from '../src/config.js'
import { accountRouter, createPluginHost } from '../src/index.js'
import { adapters } from '../src/providers/index.js'
import type { ProviderConfig, ProviderID, RouterConfig, RouterState, StoredCredential } from '../src/types.js'

type HookName = keyof SessionHooks
type Handler<Name extends HookName> = (input: SessionHooks[Name]) => Promise<void> | void
type ProviderEditor = Parameters<Parameters<Plugin.Context['provider']['transform']>[0]>[0]
type ModelEditor = Parameters<Parameters<Plugin.Context['model']['transform']>[0]>[0]
type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0]
type CommandDefinition = Parameters<CommandEditor['add']>[0]
type ConnectionResult = Awaited<ReturnType<Plugin.Context['integration']['get']>>
type Connection = ConnectionResult['data']['connections'][number]
type Scope = Pick<SessionHooks['http.request'], 'sessionID' | 'agent' | 'model' | 'kind'>
type Resolve = Plugin.Context['integration']['connection']['resolve']
type CredentialValue = NonNullable<Awaited<ReturnType<Resolve>>>
type MethodID = Extract<CredentialValue, { type: 'oauth' }>['methodID']
type ProviderGet = Plugin.Context['provider']['get']
type ProviderResult = Awaited<ReturnType<ProviderGet>>

const epoch = Date.parse('2026-11-02T12:00:00Z')
const providers = ['anthropic', 'openai'] as const
const directories: string[] = []
const cleanups: Plugin.Cleanup[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(epoch)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected network request') }))
})

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    try {
      for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  }
})

function credentials(provider: ProviderID): StoredCredential[] {
  return ['a', 'b', 'key', 'outside'].map(id => ({
    id, provider, label: `Synthetic ${id}`, method: id === 'key' ? 'key' : 'oauth', active: id === 'a',
    ...(id === 'key' ? { key: `synthetic-${provider}-key` } : { access: `synthetic-${provider}-${id}`, expiresAt: epoch + 86_400_000 }),
    ...(provider === 'openai' && id !== 'key' ? { metadata: { accountID: `workspace-${id}` } } : {}),
  }))
}

function refreshToken(value: Pick<StoredCredential, 'provider' | 'id'>): string {
  return `synthetic-refresh-${value.provider}-${value.id}`
}

function methodID(value: string): MethodID {
  return value as MethodID
}

function stored(value: StoredCredential): CredentialValue {
  if (value.method === 'key') return { type: 'key', key: value.key! }
  return {
    type: 'oauth', methodID: methodID('synthetic-oauth'), access: value.access!, refresh: refreshToken(value), expires: value.expiresAt!,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  }
}

const CODEX = 'https://chatgpt.com/backend-api/codex'
const PLATFORM = 'https://api.openai.com/v1'

function providerResult(headers: Record<string, string>, baseURL = CODEX): ProviderResult {
  return { data: { headers, settings: { baseURL } } } as unknown as ProviderResult
}

function config(provider: ProviderID, overrides: Partial<ProviderConfig> = {}): RouterConfig {
  return parseConfig({ version: 1, providers: { [provider]: { accountIDs: ['a', 'b'], allowPaidFallback: true, apiKeyAccountID: 'key', apiKeyModels: ['model'], ...overrides } } })
}

async function configFile(value?: RouterConfig): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'account-router-plugin-')))
  directories.push(directory)
  const path = join(directory, 'router.json')
  if (value) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
  return path
}

function scope(provider: string, kind: Scope['kind'] = 'primary'): Scope {
  return {
    sessionID: 'session-synthetic' as Scope['sessionID'], agent: 'build' as Scope['agent'],
    model: { providerID: provider, id: 'model' } as Scope['model'], kind,
  }
}

function context(path: string, provider: ProviderID = 'anthropic', values = credentials(provider)) {
  const connections = new Map<string, Connection[]>(providers.map(id => [id, values.filter(value => value.provider === id).map(value => ({
    id: value.id, type: 'credential', method: value.method, label: value.label,
  } as Connection))]))
  const hooks = new Map<HookName, (input: unknown) => Promise<void> | void>()
  const hookOptions = new Map<HookName, unknown>()
  const registrations: { dispose: ReturnType<typeof vi.fn<() => Promise<void>>> }[] = []
  const commands: CommandDefinition[] = []
  const providerTransforms: Parameters<Plugin.Context['provider']['transform']>[0][] = []
  const modelTransforms: Parameters<Plugin.Context['model']['transform']>[0][] = []
  const registration = (dispose: () => void = () => {}) => {
    const result = { dispose: vi.fn(async () => { dispose() }) }
    registrations.push(result)
    return result
  }
  const hook: Plugin.Context['session']['hook'] = async (name, callback, options) => {
    hooks.set(name, callback as (input: unknown) => Promise<void> | void)
    hookOptions.set(name, options)
    return registration(() => { hooks.delete(name); hookOptions.delete(name) })
  }
  const get = vi.fn<Plugin.Context['integration']['get']>(async ({ integrationID }) => ({
    data: { connections: structuredClone(connections.get(integrationID) ?? []) },
  } as unknown as ConnectionResult))
  const activate = vi.fn<Plugin.Context['credential']['activate']>(async ({ credentialID }) => {
    for (const items of connections.values()) {
      const index = items.findIndex(item => item.type === 'credential' && item.id === credentialID)
      if (index >= 0) items.unshift(...items.splice(index, 1))
    }
    return undefined as unknown as Awaited<ReturnType<Plugin.Context['credential']['activate']>>
  })
  const synthetic = vi.fn<Plugin.Context['session']['synthetic']>(async () => undefined as unknown as Awaited<ReturnType<Plugin.Context['session']['synthetic']>>)
  const sessionGet = vi.fn<Plugin.Context['session']['get']>(async () => ({ model: scope(provider).model }) as unknown as Awaited<ReturnType<Plugin.Context['session']['get']>>)
  const providerTransform: Plugin.Context['provider']['transform'] = async callback => {
    providerTransforms.push(callback)
    return registration(() => { providerTransforms.splice(providerTransforms.indexOf(callback), 1) })
  }
  const modelTransform: Plugin.Context['model']['transform'] = async callback => {
    modelTransforms.push(callback)
    return registration(() => { modelTransforms.splice(modelTransforms.indexOf(callback), 1) })
  }
  const commandTransform: Plugin.Context['command']['transform'] = async callback => {
    callback({ add: command => { commands.push(command) } })
    return registration(() => { commands.length = 0 })
  }
  const resolve = vi.fn<Resolve>(async connection => {
    const value = connection.type === 'credential' ? values.find(item => item.id === connection.id) : undefined
    return value ? structuredClone(stored(value)) : undefined
  })
  // Mirrors OpenCode rebuilding the ChatGPT workspace header and endpoint from the first (active) OpenAI connection.
  const activeValue = () => {
    const first = connections.get('openai')?.[0]
    return first?.type === 'credential' ? values.find(item => item.provider === 'openai' && item.id === first.id) : undefined
  }
  const activeHeaders = (): Record<string, string> => {
    const account = activeValue()?.metadata?.accountID
    return typeof account === 'string' ? { 'chatgpt-account-id': account } : {}
  }
  const providerGet = vi.fn<ProviderGet>(async () => providerResult(activeHeaders(), activeValue()?.method === 'key' ? PLATFORM : CODEX))
  const ctx = {
    app: { version: '2.2.5' }, options: { configPath: path }, integration: { get, connection: { resolve } }, credential: { activate },
    session: { hook, get: sessionGet, synthetic }, provider: { transform: providerTransform, get: providerGet }, model: { transform: modelTransform }, command: { transform: commandTransform },
  } as unknown as Plugin.Context
  const resolvedIDs = (): string[] => resolve.mock.calls.map(([connection]) => connection.type === 'credential' ? connection.id : connection.type)
  async function emit<Name extends HookName>(name: Name, event: SessionHooks[Name]): Promise<void> {
    const callback = hooks.get(name) as Handler<Name> | undefined
    if (!callback) throw new Error(`Missing hook: ${name}`)
    await callback(event)
  }
  async function prompt(): Promise<void> {
    await emit('prompt', { sessionID: scope(provider).sessionID } as SessionHooks['prompt'])
  }
  async function setup() {
    const cleanup = await accountRouter.setup(ctx)
    if (cleanup) {
      let disposed = false
      const dispose = async () => { if (!disposed) { disposed = true; await cleanup() } }
      cleanups.push(dispose)
      return dispose
    }
    return undefined
  }
  return { ctx, connections, hooks, hookOptions, registrations, commands, providerTransforms, modelTransforms, get, activate, synthetic, sessionGet, resolve, resolvedIDs, providerGet, activeHeaders, values, emit, prompt, setup }
}

function usageFetch() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input)
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer synthetic-/)
    if (url === 'https://api.anthropic.com/api/oauth/usage') return Response.json({ five_hour: { utilization: 20, resets_at: new Date(epoch + 18_000_000).toISOString() } })
    if (url === 'https://chatgpt.com/backend-api/wham/usage') return Response.json({ rate_limit: { allowed: true, primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: (epoch + 18_000_000) / 1000 } } })
    throw new Error(`Unexpected synthetic usage URL: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function request(provider: ProviderID, value: StoredCredential): Request {
  const paid = value.method === 'key'
  const headers = new Headers({ 'content-type': 'application/json' })
  if (provider === 'anthropic' && paid) headers.set('x-api-key', value.key!)
  else headers.set('authorization', `Bearer ${paid ? value.key : value.access}`)
  if (provider === 'openai' && !paid) headers.set('ChatGPT-Account-Id', String(value.metadata?.accountID))
  return new Request(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : paid ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', headers, body: JSON.stringify({ model: 'model', messages: [] }),
  })
}

function rejection(provider: ProviderID) {
  const body = JSON.stringify({ error: provider === 'anthropic' ? { type: 'rate_limit_error', message: 'Weekly usage limit reached' } : { type: 'usage_limit_reached' } })
  const headers = new Headers({ 'content-type': 'application/json', 'x-should-retry': 'false' })
  if (provider === 'anthropic') headers.set('anthropic-ratelimit-unified-7d-status', 'rejected')
  else headers.set('x-codex-active-limit', 'codex')
  return { body, response: new Response(body, { status: 429, headers }) }
}

function retry(provider: ProviderID, body: string, attempt = 1): SessionHooks['retry'] {
  const { sessionID, agent, model } = scope(provider)
  return {
    sessionID, agent, model, attempt, decision: { retry: false },
    error: { type: 'provider.quota', message: 'Synthetic quota rejection', status: 429, response: { body } } as SessionHooks['retry']['error'],
  }
}

async function reject(f: ReturnType<typeof context>, provider: ProviderID, value: StoredCredential, options: { kind?: Scope['kind']; attempt?: number; finalRequest?: Request; response?: Response } = {}) {
  const outgoing = options.finalRequest ?? request(provider, value)
  const event: SessionHooks['http.request'] = { ...scope(provider, options.kind), request: outgoing }
  await f.emit('http.request', event)
  const evidence = rejection(provider)
  const response = options.response ?? evidence.response
  await f.emit('http.response', { ...event, request: event.request, response })
  const input = retry(provider, evidence.body, options.attempt)
  await f.emit('retry', input)
  return { input, response, outgoing }
}

describe('real Plugin.define account-router setup', () => {
  it('single-flights simultaneous location setup into one controller and timer', async () => {
    usageFetch()
    const path = await configFile(config('anthropic'))
    const first = context(path)
    const second = context(path)
    const [disposeFirst, disposeSecond] = await Promise.all([first.setup(), second.setup()])
    expect(vi.getTimerCount()).toBe(1)
    await Promise.all([first.prompt(), second.prompt()])
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2)
    await disposeFirst?.()
    expect(vi.getTimerCount()).toBe(1)
    await disposeSecond?.()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('exports the actual public Plugin contract', () => {
    expectTypeOf(accountRouter).toMatchTypeOf<Plugin.Plugin>()
    expectTypeOf(accountRouter.setup).parameter(0).toEqualTypeOf<Plugin.Context>()
    expect(accountRouter.id).toBe('zenox.account-router')
    expect(Plugin.define(accountRouter)).toBe(accountRouter)
  })

  it.each(['missing', 'empty'] as const)('%s config registers nothing and performs no activation or credential reads', async kind => {
    const f = context(await configFile(kind === 'empty' ? defaultConfig() : undefined))
    expect(await accountRouter.setup(f.ctx)).toBeUndefined()
    expect(f.registrations).toHaveLength(0)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.providerGet).not.toHaveBeenCalled()
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['1.9.0', '2.1.9', '2.2.4', '3.0.0'])('gates unsupported version %s before registering', async version => {
    const f = context(await configFile(config('anthropic')))
    const ctx = { ...f.ctx, app: { ...f.ctx.app, version } }
    await expect(accountRouter.setup(ctx)).rejects.toThrow('2.2.5 or newer')
    expect(f.registrations).toHaveLength(0)
    expect(f.get).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it.each(['2.2.5', '2.2.15', '2.3.0'])('accepts supported version %s', async version => {
    const f = context(await configFile())
    await expect(accountRouter.setup({ ...f.ctx, app: { ...f.ctx.app, version } })).resolves.toBeUndefined()
  })

  it.each(providers)('forces HTTP only for configured %s provider and its models', async provider => {
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    const providerRecords = new Map(['anthropic', 'openai', 'other'].map(id => [id, { settings: { transport: 'websocket', preserved: id } }]))
    const modelRecords = new Map(['anthropic', 'openai', 'other'].map(id => [id, [{ id: 'model', settings: { transport: 'websocket', preserved: id } }, { id: 'second', settings: { transport: 'auto', preserved: id } }]]))
    const updateProvider = vi.fn<ProviderEditor['update']>((id, update) => { update(providerRecords.get(id) as unknown as Parameters<typeof update>[0]) })
    const updateModel = vi.fn<ModelEditor['update']>((id, modelID, update) => { update(modelRecords.get(id)!.find(model => model.id === modelID) as unknown as Parameters<typeof update>[0]) })
    const list = vi.fn<ModelEditor['list']>(id => modelRecords.get(id!) as unknown as ReturnType<ModelEditor['list']>)
    f.providerTransforms[0]!({ update: updateProvider } as unknown as ProviderEditor)
    f.modelTransforms[0]!({ list, update: updateModel } as unknown as ModelEditor)
    expect(updateProvider.mock.calls.map(([id]) => id)).toEqual([provider])
    expect(updateModel.mock.calls.map(([id, model]) => [id, model])).toEqual([[provider, 'model'], [provider, 'second']])
    for (const [id, value] of providerRecords) expect(value.settings).toEqual({ transport: id === provider ? 'http' : 'websocket', preserved: id })
    for (const [id, models] of modelRecords) for (const [index, model] of models.entries()) expect(model.settings).toEqual({ transport: id === provider ? 'http' : index === 0 ? 'websocket' : 'auto', preserved: id })
    expect([...f.hooks.keys()]).toEqual(['prompt', 'http.request', 'http.response', 'retry'])
    expect([...f.hookOptions.values()].every(options => options === undefined)).toBe(true)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('status command adds a synthetic message with resume:false and never runs inference', async () => {
    const f = context(await configFile(config('anthropic')))
    await f.setup()
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0]!.name).toBe('router-status')
    await f.commands[0]!.execute({ sessionID: scope('anthropic').sessionID } as Parameters<CommandDefinition['execute']>[0])
    expect(f.synthetic).toHaveBeenCalledWith({ sessionID: scope('anthropic').sessionID, text: expect.any(String), resume: false })
    expect(f.sessionGet).not.toHaveBeenCalled()
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe.each(providers)('%s companion hooks with actual credential matching', provider => {
  it('initializes at prompt before simulated auth transport and preserves selected active A', async () => {
    const monitor = usageFetch()
    const f = context(await configFile(config(provider, { favoriteAccountID: 'b' })), provider)
    await f.setup()
    expect(monitor).not.toHaveBeenCalled()
    await f.prompt()
    expect(monitor).toHaveBeenCalledTimes(2)
    const state = JSON.parse(await readFile(defaultStatePath(String(f.ctx.options.configPath)), 'utf8')) as RouterState
    expect(state.usage[`${provider}:a`]?.status).toBe('ok')
    expect(state.usage[`${provider}:b`]?.status).toBe('ok')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.connections.get(provider)![0]).toMatchObject({ type: 'credential', id: 'a' })
    const authTransport = vi.fn(async () => request(provider, f.values.find(value => value.id === 'a')!))
    const outgoing = await authTransport()
    expect(outgoing.headers.get('authorization')).toBe(`Bearer synthetic-${provider}-a`)
    await f.emit('http.request', { ...scope(provider), request: outgoing })
    await f.emit('http.response', { ...scope(provider), request: outgoing, response: new Response('ok') })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('attributes the upstream-rewritten final Request to token A, overrides retry:false, and leaves the original response readable', async () => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const event: SessionHooks['http.request'] = { ...scope(provider), request: new Request('https://placeholder.invalid/') }
    const original = event.request
    // Simulate the upstream auth hook; the companion observes its final Request identity.
    event.request = request(provider, f.values.find(value => value.id === 'a')!)
    const finalRequest = event.request
    await f.emit('http.request', event)
    expect(event.request).toBe(finalRequest)
    expect(event.request).not.toBe(original)
    const evidence = rejection(provider)
    expect(evidence.response.headers.get('x-should-retry')).toBe('false')
    await f.emit('http.response', { ...event, response: evidence.response })
    expect(evidence.response.bodyUsed).toBe(false)
    expect(await evidence.response.text()).toBe(evidence.body)
    const input = retry(provider, evidence.body)
    await f.emit('retry', input)
    expect(input.decision).toEqual({ retry: true, delay: 0 })
    expect(f.activate.mock.calls.map(([input]) => input.credentialID)).toEqual(['b'])
    // OpenAI activation settles on the rebuilt workspace header (already B here); Anthropic never polls.
    expect(f.providerGet).toHaveBeenCalledTimes(provider === 'openai' ? 1 : 0)
  })

  it('does not correlate a response to a different, byte-identical Request object', async () => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const outgoing = request(provider, f.values[0]!)
    await f.emit('http.request', { ...scope(provider), request: outgoing })
    const evidence = rejection(provider)
    await f.emit('http.response', { ...scope(provider), request: outgoing.clone(), response: evidence.response })
    const input = retry(provider, evidence.body)
    await f.emit('retry', input)
    expect(input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not attribute an unknown upstream token to the active account', async () => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const unknown = request(provider, { ...f.values[0]!, access: 'synthetic-unrecognized-upstream-token' })
    const result = await reject(f, provider, f.values[0]!, { finalRequest: unknown })
    expect(result.input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it.each(['allowed', 'disabled', 'model excluded'] as const)('A then B uses a key only when paid fallback is %s', async mode => {
    usageFetch()
    const settings = mode === 'disabled' ? { allowPaidFallback: false } : mode === 'model excluded' ? { apiKeyModels: ['different-model'] } : {}
    const f = context(await configFile(config(provider, settings)), provider)
    await f.setup()
    await f.prompt()
    expect((await reject(f, provider, f.values[0]!)).input.decision).toEqual({ retry: true, delay: 0 })
    const second = await reject(f, provider, f.values[1]!, { attempt: 2 })
    expect(second.input.decision).toEqual(mode === 'allowed' ? { retry: true, delay: 0 } : { retry: false })
    expect(f.activate.mock.calls.map(([input]) => input.credentialID)).toEqual(mode === 'allowed' ? ['b', 'key'] : ['b'])
    expect(f.resolvedIDs()).not.toContain('outside')
    expect(f.resolvedIDs().includes('key')).toBe(mode !== 'disabled')
    expect(f.providerGet).toHaveBeenCalledTimes(provider === 'openai' ? f.activate.mock.calls.length : 0)
    if (mode !== 'allowed') return
    // Construct the hypothetical next core request ourselves; this does not test a core rebuild.
    const paid = request(provider, f.values[2]!)
    expect(paid.url).toBe(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses')
    expect(paid.headers.has('ChatGPT-Account-Id')).toBe(false)
    expect(paid.headers.has('anthropic-beta')).toBe(false)
    expect(paid.headers.get(provider === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(provider === 'anthropic' ? 'synthetic-anthropic-key' : 'Bearer synthetic-openai-key')
    expect(adapters[provider].matchesRequest(f.values[2]!, paid)).toBe(true)
    expect(adapters[provider].matchesRequest(f.values[0]!, paid)).toBe(false)
    const wrongOrigin = new Request(`https://untrusted.invalid${new URL(paid.url).pathname}`, { headers: paid.headers })
    expect(adapters[provider].matchesRequest(f.values[2]!, wrongOrigin)).toBe(false)
    const paidHeaders = [...paid.headers]
    const last = await reject(f, provider, f.values[2]!, { attempt: 3, finalRequest: paid })
    expect(last.outgoing).toBe(paid)
    expect([...paid.headers]).toEqual(paidHeaders)
    expect(last.input.decision).toEqual({ retry: false })
    const state = JSON.parse(await readFile(defaultStatePath(String(f.ctx.options.configPath)), 'utf8')) as RouterState
    expect(state.cooldowns[`${provider}:key`]).toBeDefined()
    expect(f.activate).toHaveBeenCalledTimes(2)
  })

  it.each(['title', 'compaction', 'generate'] as const)('does not switch accounts for auxiliary %s quota', async kind => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const result = await reject(f, provider, f.values[0]!, { kind })
    expect(result.input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not inspect or replay a successful SSE stream', async () => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const text = `event: error\ndata: ${rejection(provider).body}\n\n`
    const response = new Response(text, { headers: { 'content-type': 'text/event-stream' } })
    const result = await reject(f, provider, f.values[0]!, { response })
    expect(result.input.decision).toEqual({ retry: false })
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe(text)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('does not activate after a later hook replaces the final request with an unknown credential', async () => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    await f.prompt()
    const event: SessionHooks['http.request'] = { ...scope(provider), request: request(provider, f.values[0]!) }
    await f.emit('http.request', event)
    const laterRequest = request(provider, { ...f.values[0]!, access: 'synthetic-unknown-token' })
    event.request = laterRequest
    const evidence = rejection(provider)
    await f.emit('http.response', { ...event, response: evidence.response })
    const input = retry(provider, evidence.body)
    await f.emit('retry', input)
    expect(input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('leaves unconfigured provider requests, responses, and retry decisions untouched', async () => {
    const monitor = usageFetch()
    const f = context(await configFile(config(provider)), provider)
    await f.setup()
    const other = provider === 'anthropic' ? 'openai' : 'anthropic'
    const outgoing = request(other, credentials(other)[0]!)
    const event: SessionHooks['http.request'] = { ...scope(other), request: outgoing }
    const evidence = rejection(other)
    await f.emit('http.request', event)
    await f.emit('http.response', { ...event, response: evidence.response })
    const input = retry(other, evidence.body)
    await f.emit('retry', input)
    expect(event.request).toBe(outgoing)
    expect(input.decision).toEqual({ retry: false })
    expect(await evidence.response.text()).toBe(evidence.body)
    expect(f.get).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.providerGet).not.toHaveBeenCalled()
    expect(monitor).not.toHaveBeenCalled()
    expect(f.activate).not.toHaveBeenCalled()
  })
})

describe('shared controller and registration lifecycle', () => {
  it('shares one poller/controller across locations, keeps remaining hooks alive, and releases final references', async () => {
    const monitor = usageFetch()
    const path = await configFile(config('anthropic'))
    const first = context(path)
    const second = context(path)
    const disposeFirst = await first.setup()
    const disposeSecond = await second.setup()
    expect(vi.getTimerCount()).toBe(1)
    expect(first.registrations).toHaveLength(7)
    expect(second.registrations).toHaveLength(7)
    await Promise.all([first.prompt(), second.prompt()])
    expect(monitor).toHaveBeenCalledTimes(2)
    // One shared credential read through the first location's host: each selected account resolved once.
    expect(first.resolvedIDs()).toEqual(['a', 'b', 'key'])
    expect(second.resolve).not.toHaveBeenCalled()
    await disposeFirst!()
    expect(first.hooks.size).toBe(0)
    expect(first.commands).toHaveLength(0)
    expect(first.providerTransforms).toHaveLength(0)
    expect(first.modelTransforms).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    expect((await reject(second, 'anthropic', second.values[0]!)).input.decision).toEqual({ retry: true, delay: 0 })
    expect(second.activate).toHaveBeenCalledWith({ credentialID: 'b' })
    expect(first.activate).not.toHaveBeenCalled()
    await disposeSecond!()
    expect(vi.getTimerCount()).toBe(0)
    expect(second.hooks.size).toBe(0)
    for (const registration of [...first.registrations, ...second.registrations]) expect(registration.dispose).toHaveBeenCalledTimes(1)
    const fresh = context(path)
    const disposeFresh = await fresh.setup()
    expect(vi.getTimerCount()).toBe(1)
    await disposeFresh!()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed on conflicting config reload without disrupting the original location', async () => {
    usageFetch()
    const path = await configFile(config('anthropic'))
    const original = context(path)
    await original.setup()
    await writeFile(path, JSON.stringify(config('anthropic', { favoriteAccountID: 'b' })), { mode: 0o600 })
    const conflicting = context(path)
    await expect(conflicting.setup()).rejects.toThrow('reload all OpenCode locations')
    expect(conflicting.registrations).toHaveLength(0)
    expect(conflicting.activate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await original.prompt()
    expect((await reject(original, 'anthropic', original.values[0]!)).input.decision).toEqual({ retry: true, delay: 0 })
  })

  it('disposes partial registrations and stops the poller when setup fails', async () => {
    const f = context(await configFile(config('anthropic')))
    const ctx = { ...f.ctx, model: { ...f.ctx.model, transform: vi.fn<Plugin.Context['model']['transform']>(async () => { throw new Error('Synthetic registration failure') }) } }
    await expect(accountRouter.setup(ctx)).rejects.toThrow('Synthetic registration failure')
    expect(f.registrations).toHaveLength(1)
    expect(f.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.providerTransforms).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await f.setup()
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('createPluginHost credentials through OpenCode integrations', () => {
  it('resolves only accounts selected in the router config, and the key only when paid fallback is allowed', async () => {
    const f = context(await configFile())
    const host = createPluginHost(f.ctx, config('anthropic'))
    const accounts = await host.listAccounts()
    expect(accounts.map(value => value.id)).toEqual(['a', 'b', 'key', 'outside'])
    expect(f.resolve).not.toHaveBeenCalled()
    const values = await host.readCredentials('anthropic')
    expect(values.map(value => value.id)).toEqual(['a', 'b', 'key'])
    expect(f.resolvedIDs()).toEqual(['a', 'b', 'key'])
    expect(values.find(value => value.id === 'key')).toMatchObject({ method: 'key', key: 'synthetic-anthropic-key' })
    expect(await host.readCredentials('openai')).toEqual([])
    expect(f.get.mock.calls.map(([input]) => input.integrationID)).toEqual(['anthropic', 'openai', 'anthropic'])

    const unpaid = context(await configFile())
    const unpaidHost = createPluginHost(unpaid.ctx, config('anthropic', { allowPaidFallback: false }))
    expect((await unpaidHost.readCredentials('anthropic')).map(value => value.id)).toEqual(['a', 'b'])
    expect(unpaid.resolvedIDs()).toEqual(['a', 'b'])
    expect(unpaid.resolvedIDs()).not.toContain('outside')
  })

  it('rejects activation of accounts that are not OpenCode connections for that provider', async () => {
    const f = context(await configFile())
    const host = createPluginHost(f.ctx, config('anthropic'))
    await expect(host.activate('anthropic', 'foreign-service-account')).rejects.toThrow('unavailable')
    await expect(host.activate('openai', 'a')).rejects.toThrow('unavailable')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.providerGet).not.toHaveBeenCalled()
  })

  it('marks an account needsAuth when resolve throws or returns an unexpected credential type', async () => {
    const f = context(await configFile())
    f.resolve.mockImplementation(async connection => {
      const id = connection.type === 'credential' ? connection.id : ''
      if (id === 'a') throw new Error('Synthetic refresh failure')
      if (id === 'b') return { type: 'external', methodID: methodID('synthetic-external') }
      if (id === 'key') return { type: 'oauth', methodID: methodID('synthetic-oauth'), access: 'synthetic-wrong-type', refresh: 'synthetic-refresh-wrong', expires: epoch }
      return undefined
    })
    const host = createPluginHost(f.ctx, config('anthropic'))
    const values = await host.readCredentials('anthropic')
    expect(values).toEqual(['a', 'b', 'key'].map(id => ({
      id, provider: 'anthropic', label: `Synthetic ${id}`, method: id === 'key' ? 'key' : 'oauth', active: id === 'a', needsAuth: true,
    })))
    f.resolve.mockResolvedValueOnce(undefined)
    expect((await host.readCredentials('anthropic'))[0]).toMatchObject({ id: 'a', needsAuth: true })
    expect(JSON.stringify(values)).not.toMatch(/synthetic-(?:wrong-type|refresh)/)
  })

  it('treats a connection status as needsAuth without resolving it', async () => {
    const f = context(await configFile())
    f.connections.set('anthropic', f.connections.get('anthropic')!.map(item => item.type === 'credential' && item.id === 'b'
      ? { ...item, status: { status: 'needs_auth', message: 'Synthetic sign-in required' } } as Connection
      : item))
    const host = createPluginHost(f.ctx, config('anthropic'))
    expect((await host.listAccounts()).find(value => value.id === 'b')).toMatchObject({ needsAuth: true })
    const values = await host.readCredentials('anthropic')
    expect(values.find(value => value.id === 'b')).toEqual({ id: 'b', provider: 'anthropic', label: 'Synthetic b', method: 'oauth', active: false, needsAuth: true })
    expect(values.find(value => value.id === 'a')).not.toHaveProperty('needsAuth')
    expect(f.resolvedIDs()).toEqual(['a', 'key'])
  })

  it.each(providers)('never returns or persists %s refresh tokens', async provider => {
    usageFetch()
    const f = context(await configFile(config(provider)), provider)
    const host = createPluginHost(f.ctx, config(provider))
    const values = await host.readCredentials(provider)
    expect(f.resolve).toHaveBeenCalled()
    for (const value of values) expect(Object.keys(value).sort()).toEqual(value.method === 'key'
      ? ['active', 'id', 'key', 'label', 'method', 'provider']
      : ['access', 'active', 'expiresAt', 'id', 'label', 'method', 'provider', ...(provider === 'openai' ? ['metadata'] : [])].sort())
    expect(values.find(value => value.id === 'a')).toMatchObject({ access: `synthetic-${provider}-a`, expiresAt: epoch + 86_400_000 })
    expect(JSON.stringify(values)).not.toContain('synthetic-refresh')
    await f.setup()
    await f.prompt()
    const state = await readFile(defaultStatePath(String(f.ctx.options.configPath)), 'utf8')
    expect(state).not.toContain('synthetic-refresh')
    expect(state).not.toContain(`synthetic-${provider}-a`)
  })

  it('whitelists credential metadata', async () => {
    const f = context(await configFile(), 'openai')
    f.resolve.mockImplementation(async (connection): Promise<CredentialValue> => ({
      type: 'oauth', methodID: methodID('synthetic-oauth'), access: 'synthetic-openai-a', refresh: 'synthetic-refresh-openai-a', expires: epoch + 1,
      metadata: connection.type === 'credential' && connection.id === 'a'
        ? {
            accountID: 'workspace-a', accountId: 'workspace-camel', account_id: 'bad\u0000value', chatgpt_account_id: 'x'.repeat(257),
            chatgpt_account_is_fedramp: true, is_fedramp: false, isFedramp: 'true', id_token: 'synthetic-id-token', email: 'synthetic@example.invalid', nested: { accountID: 'nested' },
          }
        : { id_token: 'synthetic-id-token' },
    }))
    const values = await createPluginHost(f.ctx, config('openai')).readCredentials('openai')
    expect(values.find(value => value.id === 'a')!.metadata).toEqual({ accountID: 'workspace-a', accountId: 'workspace-camel', chatgpt_account_is_fedramp: true, is_fedramp: false })
    expect(values.find(value => value.id === 'b')).not.toHaveProperty('metadata')
    expect(JSON.stringify(values)).not.toMatch(/synthetic-id-token|synthetic@example|nested|synthetic-refresh/)
  })

  it('ignores env/external/unsupported methods and preserves first-connection activation semantics', async () => {
    const f = context(await configFile())
    f.connections.set('anthropic', [
      { type: 'env', name: 'SYNTHETIC_ENV' },
      { type: 'credential', id: 'external', method: 'external', label: 'Synthetic external' },
      { type: 'credential', id: 'unsupported', method: 'custom', label: 'Synthetic unsupported' },
      ...f.connections.get('anthropic')!,
    ] as unknown as Connection[])
    const host = createPluginHost(f.ctx, config('anthropic', { accountIDs: ['a', 'b', 'external', 'unsupported'] }))
    const accounts = await host.listAccounts()
    // The unsupported active connection is surfaced as an active, unusable account so routing leaves it alone.
    expect(accounts.map(value => value.id)).toEqual(['env:SYNTHETIC_ENV', 'a', 'b', 'key', 'outside'])
    expect(accounts[0]).toMatchObject({ active: true, needsAuth: true })
    expect(accounts.slice(1).every(value => !value.active)).toBe(true)
    const values = await host.readCredentials('anthropic')
    expect(values.map(value => value.id)).toEqual(['a', 'b', 'key'])
    expect(values.every(value => !value.active)).toBe(true)
    expect(f.resolvedIDs()).toEqual(['a', 'b', 'key'])
    expect(f.get.mock.calls.slice(0, 2).map(([input]) => input.integrationID)).toEqual(['anthropic', 'openai'])
  })

  it('uses service activation order, propagates metadata, and fails matching safely on an account metadata mismatch', async () => {
    const f = context(await configFile(), 'openai')
    const items = f.connections.get('openai')!
    items.unshift(...items.splice(1, 1))
    const host = createPluginHost(f.ctx, config('openai'))
    const values = await host.readCredentials('openai')
    expect(values.map(value => value.id)).toEqual(['b', 'a', 'key'])
    const a = values.find(value => value.id === 'a')!
    expect(a.active).toBe(false)
    expect(values.find(value => value.id === 'b')!.active).toBe(true)
    expect(a.metadata).toEqual({ accountID: 'workspace-a' })
    const mismatch = request('openai', { ...a, metadata: { accountID: 'different-workspace' } })
    expect(adapters.openai.matchesRequest(a, mismatch)).toBe(false)
    expect(mismatch.headers.get('ChatGPT-Account-Id')).toBe('different-workspace')
    expect(f.values[0]!.metadata).toEqual({ accountID: 'workspace-a' })
    expect(f.activate).not.toHaveBeenCalled()
  })

  it.each(providers)('does not fail over to a %s account whose resolve throws', async provider => {
    const monitor = usageFetch()
    const f = context(await configFile(config(provider)), provider)
    f.resolve.mockImplementation(async connection => {
      if (connection.type === 'credential' && connection.id === 'b') throw new Error('Synthetic refresh failure')
      const value = connection.type === 'credential' ? f.values.find(item => item.id === connection.id) : undefined
      return value ? stored(value) : undefined
    })
    await f.setup()
    await f.prompt()
    expect(monitor).toHaveBeenCalledTimes(1)
    const state = JSON.parse(await readFile(defaultStatePath(String(f.ctx.options.configPath)), 'utf8')) as RouterState
    expect(state.usage[`${provider}:b`]?.status).toBe('needs-auth')
    const result = await reject(f, provider, f.values[0]!)
    expect(result.input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.providerGet).not.toHaveBeenCalled()
  })
})

describe('createPluginHost OpenAI activation settling', () => {
  it('confirms as soon as the rebuilt workspace header and Codex endpoint match the activated account', async () => {
    const f = context(await configFile(), 'openai')
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'b')).resolves.toBe(true)
    expect(f.activate).toHaveBeenCalledWith({ credentialID: 'b' })
    expect(f.providerGet).toHaveBeenCalledTimes(1)
    expect(f.providerGet).toHaveBeenCalledWith({ providerID: 'openai' })
    expect(f.resolvedIDs()).toEqual(['b'])
  })

  it('waits for a stale workspace header to be replaced', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet
      .mockResolvedValueOnce(providerResult({ 'chatgpt-account-id': 'workspace-a' }))
      .mockResolvedValueOnce(providerResult({}))
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'b')).resolves.toBe(true)
    expect(f.providerGet).toHaveBeenCalledTimes(3)
  })

  it('waits for the endpoint to switch to Codex even when the header already matches', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet.mockResolvedValueOnce(providerResult({ 'chatgpt-account-id': 'workspace-b' }, PLATFORM))
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'b')).resolves.toBe(true)
    expect(f.providerGet).toHaveBeenCalledTimes(2)
  })

  it('waits for the header to disappear and the endpoint to leave Codex after activating an API key', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet
      .mockResolvedValueOnce(providerResult({ 'chatgpt-account-id': 'workspace-a' }))
      .mockResolvedValueOnce(providerResult({}, CODEX))
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'key')).resolves.toBe(true)
    expect(f.activate).toHaveBeenCalledWith({ credentialID: 'key' })
    expect(f.providerGet).toHaveBeenCalledTimes(3)
  })

  it('reports an unconfirmed switch after its overall time budget, even with a frozen clock', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet.mockImplementation(async () => providerResult({ 'chatgpt-account-id': 'workspace-stale' }))
    const started = performance.now()
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'b')).resolves.toBe(false)
    expect(performance.now() - started).toBeLessThan(4_000)
    expect(f.activate).toHaveBeenCalledWith({ credentialID: 'b' })
    expect(f.providerGet.mock.calls.length).toBeGreaterThan(10)
  }, 10_000)

  it('does not hang activation when provider.get never settles', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet.mockImplementation(() => new Promise(() => {}))
    await expect(createPluginHost(f.ctx, config('openai')).activate('openai', 'b')).resolves.toBe(false)
    expect(f.providerGet).toHaveBeenCalledTimes(1)
  }, 5_000)

  it('reports provider.get and resolve errors as unconfirmed without blocking activation', async () => {
    const f = context(await configFile(), 'openai')
    f.providerGet.mockRejectedValueOnce(new Error('Synthetic provider failure'))
    const host = createPluginHost(f.ctx, config('openai'))
    await expect(host.activate('openai', 'b')).resolves.toBe(false)
    expect(f.providerGet).toHaveBeenCalledTimes(1)
    f.resolve.mockRejectedValueOnce(new Error('Synthetic refresh failure'))
    await expect(host.activate('openai', 'a')).resolves.toBe(false)
    expect(f.providerGet).toHaveBeenCalledTimes(1)
    expect(f.activate.mock.calls.map(([input]) => input.credentialID)).toEqual(['b', 'a'])
  })

  it('never polls the provider after an Anthropic activation', async () => {
    const f = context(await configFile())
    await expect(createPluginHost(f.ctx, config('anthropic')).activate('anthropic', 'b')).resolves.toBe(true)
    expect(f.activate).toHaveBeenCalledWith({ credentialID: 'b' })
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.providerGet).not.toHaveBeenCalled()
  })
})

describe('createPluginHost refresh discipline', () => {
  it('remembers a failed resolve and does not retry it on every read', async () => {
    const f = context(await configFile())
    f.resolve.mockImplementation(async connection => {
      if (connection.type === 'credential' && connection.id === 'b') throw new Error('Synthetic refresh failure')
      const value = connection.type === 'credential' ? f.values.find(item => item.id === connection.id) : undefined
      return value ? stored(value) : undefined
    })
    const host = createPluginHost(f.ctx, config('anthropic'))
    for (let index = 0; index < 5; index++) {
      const values = await host.readCredentials('anthropic', { refresh: index % 2 === 0 })
      expect(values.find(value => value.id === 'b')).toMatchObject({ needsAuth: true })
    }
    expect(f.resolvedIDs().filter(id => id === 'b')).toHaveLength(1)
    vi.setSystemTime(epoch + 600_001)
    await host.readCredentials('anthropic')
    expect(f.resolvedIDs().filter(id => id === 'b')).toHaveLength(2)
  })

  it('monitoring reads never ask the owner to refresh a known-expiring idle token; failover reads do', async () => {
    const values = credentials('anthropic').map(value => value.id === 'b' ? { ...value, expiresAt: epoch + 60_000 } : value)
    const f = context(await configFile(), 'anthropic', values)
    const host = createPluginHost(f.ctx, config('anthropic'))
    await host.readCredentials('anthropic')
    expect(f.resolvedIDs().filter(id => id === 'b')).toHaveLength(1)
    await host.readCredentials('anthropic')
    await host.readCredentials('anthropic')
    expect(f.resolvedIDs().filter(id => id === 'b')).toHaveLength(1)
    await host.readCredentials('anthropic', { refresh: true })
    expect(f.resolvedIDs().filter(id => id === 'b')).toHaveLength(2)
  })

  it.each(providers)('%s: keeps attributing and failing over after the active account\'s owner rotates its near-expiry token', async provider => {
    usageFetch()
    const values = credentials(provider).map(value => value.id === 'a' ? { ...value, expiresAt: epoch + 60_000 } : value)
    const f = context(await configFile(config(provider)), provider, values)
    await f.setup()
    await f.prompt()
    // The owner refreshes A inside the 5-minute margin, exactly when the router's copy looks "expiring".
    const a = f.values.find(value => value.id === 'a')!
    a.access = `synthetic-${provider}-a-rotated`
    a.expiresAt = epoch + 8 * 3_600_000
    vi.setSystemTime(epoch + 30_000)
    const result = await reject(f, provider, a)
    expect(result.input.decision).toEqual({ retry: true, delay: 0 })
    expect(f.activate.mock.calls.map(([input]) => input.credentialID)).toEqual(['b'])
  })

  it('does not remember a failed resolve of the active account (OpenCode refreshes it anyway)', async () => {
    const f = context(await configFile())
    f.resolve.mockRejectedValueOnce(new Error('Synthetic transient failure'))
    const host = createPluginHost(f.ctx, config('anthropic'))
    expect((await host.readCredentials('anthropic')).find(value => value.id === 'a')).toMatchObject({ needsAuth: true })
    expect((await host.readCredentials('anthropic')).find(value => value.id === 'a')).toMatchObject({ access: 'synthetic-anthropic-a' })
  })

  it('times out a resolve that never settles and marks only that account', async () => {
    // setTimeout is real in this suite; only Date and intervals are faked.
    const f = context(await configFile())
    f.resolve.mockImplementation(async connection => {
      if (connection.type === 'credential' && connection.id === 'b') return new Promise<never>(() => {})
      const value = connection.type === 'credential' ? f.values.find(item => item.id === connection.id) : undefined
      return value ? stored(value) : undefined
    })
    const started = performance.now()
    const values = await createPluginHost(f.ctx, config('anthropic')).readCredentials('anthropic')
    expect(performance.now() - started).toBeLessThan(7_000)
    expect(values.find(value => value.id === 'b')).toMatchObject({ needsAuth: true })
    expect(values.find(value => value.id === 'a')).toMatchObject({ access: 'synthetic-anthropic-a' })
  }, 10_000)

  it('an unsupported active connection suspends routing: no activation, monitoring or resolves', async () => {
    const monitor = usageFetch()
    const f = context(await configFile(config('anthropic')))
    f.connections.set('anthropic', [{ type: 'env', name: 'SYNTHETIC_ENV' } as unknown as Connection, ...f.connections.get('anthropic')!])
    await f.setup()
    await f.prompt()
    const result = await reject(f, 'anthropic', f.values[0]!)
    expect(result.input.decision).toEqual({ retry: false })
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(monitor).not.toHaveBeenCalled()
  })
})
