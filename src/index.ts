import type { Plugin } from '@opencode/plugin'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defaultConfigPath, defaultStatePath, loadConfig, readState, saveState } from './config.js'
import { RouterController } from './controller.js'
import { buildReport, formatReport } from './report.js'
import { RouterRpc } from './rpc.js'
import { PROVIDERS } from './types.js'
import type { Account, ProviderID, RouterConfig, RouterHost, StoredCredential } from './types.js'

interface Pool {
  controller: RouterController
  hosts: Map<symbol, RouterHost>
  timer: ReturnType<typeof setInterval>
  fingerprint: string
}

const global = globalThis as typeof globalThis & { __openCodeAccountRouterV1?: Map<string, Pool>; __openCodeAccountRouterCreatingV1?: Map<string, Promise<Pool>> }
const pools = global.__openCodeAccountRouterV1 ??= new Map<string, Pool>()
const creating = global.__openCodeAccountRouterCreatingV1 ??= new Map<string, Promise<Pool>>()

async function acquirePool(configPath: string, statePath: string, config: RouterConfig, fingerprint: string): Promise<Pool> {
  let pool = pools.get(configPath)
  if (!pool) {
    let pending = creating.get(configPath)
    if (!pending) {
      pending = (async () => {
        const state = await readState(statePath)
        const hosts = new Map<symbol, RouterHost>()
        const latestHost = (): RouterHost => {
          const value = hosts.values().next().value
          if (!value) throw new Error('Router host unavailable.')
          return value
        }
        const controller = new RouterController({
          config, state,
          host: {
            listAccounts: () => latestHost().listAccounts(),
            readCredentials: (provider, options) => latestHost().readCredentials(provider, options),
            activate: (provider, accountID) => latestHost().activate(provider, accountID),
          },
          persist: value => saveState(value, statePath),
        })
        const timer = setInterval(() => { void controller.tick().catch(() => undefined) }, 30_000)
        timer.unref()
        const result: Pool = { controller, hosts, timer, fingerprint }
        pools.set(configPath, result)
        return result
      })()
      creating.set(configPath, pending)
      const finish = (): void => { if (creating.get(configPath) === pending) creating.delete(configPath) }
      void pending.then(finish, finish)
    }
    pool = await pending
  }
  if (pool.fingerprint !== fingerprint) throw new Error('Router preferences changed; reload all OpenCode locations to apply them together.')
  return pool
}

type Connection = Awaited<ReturnType<Plugin.Context['integration']['get']>>['data']['connections'][number]
type CredentialConnection = Extract<Connection, { type: 'credential' }>

function metadata(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const source = input as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const name of ['accountID', 'accountId', 'account_id', 'chatgpt_account_id']) {
    const value = source[name]
    if (typeof value === 'string' && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value)) result[name] = value
  }
  for (const name of ['chatgpt_account_is_fedramp', 'is_fedramp', 'isFedramp']) if (typeof source[name] === 'boolean') result[name] = source[name]
  return Object.keys(result).length ? result : undefined
}

const TIMED_OUT = Symbol('timed out')
function within<T>(operation: Promise<T>, milliseconds: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, milliseconds)) })
  return Promise.race([operation, limit]).finally(() => clearTimeout(timer))
}

const RESOLVE_TIMEOUT_MS = 5_000
const EXPIRY_MARGIN_MS = 300_000

/**
 * Credentials are resolved through OpenCode, which owns token refresh. Only accounts selected in the
 * router configuration are resolved, and refresh tokens are dropped immediately. Owner refresh of an
 * idle account only happens when routing needs it (`refresh: true`); monitoring and attribution reuse
 * the last value for known-expiring tokens. Failed resolves are remembered so a broken account is not
 * retried on every request.
 */
export function createPluginHost(ctx: Plugin.Context, config: RouterConfig): RouterHost {
  const known = new Map<string, StoredCredential>()
  const failed = new Map<string, number>()
  const connections = async (provider: ProviderID): Promise<{ connection: CredentialConnection; account: Account }[]> => {
    const { data } = await ctx.integration.get({ integrationID: provider })
    const result: { connection: CredentialConnection; account: Account }[] = []
    for (const [index, connection] of data.connections.entries()) {
      if (connection.type !== 'credential' || (connection.method !== 'oauth' && connection.method !== 'key')) continue
      result.push({ connection, account: { id: connection.id, provider, label: connection.label, method: connection.method, active: index === 0, ...(connection.status ? { needsAuth: true } : {}) } })
    }
    return result
  }
  const listAccounts = async (): Promise<Account[]> => {
    const accounts: Account[] = []
    for (const provider of PROVIDERS) {
      const { data } = await ctx.integration.get({ integrationID: provider })
      const first = data.connections[0]
      // An env/external/unsupported active connection is reported as an unusable active account,
      // so the controller leaves it alone instead of believing nothing is active.
      if (first && !(first.type === 'credential' && (first.method === 'oauth' || first.method === 'key'))) {
        accounts.push({ id: `${first.type}:${first.type === 'credential' ? first.id : first.name}`, provider, label: 'Unsupported active connection', method: 'key', active: true, needsAuth: true })
      }
      for (const [index, connection] of data.connections.entries()) {
        if (connection.type !== 'credential' || (connection.method !== 'oauth' && connection.method !== 'key')) continue
        accounts.push({ id: connection.id, provider, label: connection.label, method: connection.method, active: index === 0, ...(connection.status ? { needsAuth: true } : {}) })
      }
    }
    return accounts
  }
  const read = async (connection: CredentialConnection, account: Account, refresh: boolean): Promise<StoredCredential> => {
    const now = Date.now()
    if ((failed.get(account.id) ?? 0) > now) return { ...account, needsAuth: true }
    const previous = known.get(account.id)
    // Only idle accounts reuse a known-expiring value. The active account's owner rotates its token
    // inside this same margin, so it must be re-read or request attribution would go permanently stale.
    if (!refresh && !account.active && previous?.method === 'oauth' && previous.expiresAt !== undefined && previous.expiresAt - EXPIRY_MARGIN_MS <= now) return { ...previous, active: false }
    let value: Awaited<ReturnType<Plugin.Context['integration']['connection']['resolve']>> | typeof TIMED_OUT
    try { value = await within(ctx.integration.connection.resolve(connection), RESOLVE_TIMEOUT_MS) } catch { value = undefined }
    let result: StoredCredential
    if (value !== TIMED_OUT && value?.type === 'oauth' && account.method === 'oauth') {
      const extra = metadata(value.metadata)
      result = { ...account, access: value.access, expiresAt: value.expires, ...(extra ? { metadata: extra } : {}) }
    } else if (value !== TIMED_OUT && value?.type === 'key' && account.method === 'key') result = { ...account, key: value.key }
    else {
      // OpenCode already refreshes the active account on its own requests, so remembering its failure
      // would only disable failover for it without saving any refresh traffic.
      if (!account.active) failed.set(account.id, now + config.pollIntervalMs)
      return { ...account, needsAuth: true }
    }
    failed.delete(account.id)
    known.set(account.id, result)
    return result
  }
  return {
    listAccounts,
    async readCredentials(provider, options = {}) {
      const settings = config.providers[provider]
      if (!settings) return []
      const wanted = new Set([...settings.accountIDs, ...(settings.allowPaidFallback && settings.apiKeyAccountID ? [settings.apiKeyAccountID] : [])])
      const items = (await connections(provider)).filter(item => wanted.has(item.account.id))
      const results = await Promise.allSettled(items.map(({ connection, account }) => account.needsAuth ? Promise.resolve(account) : read(connection, account, options.refresh === true)))
      return results.map((result, index) => result.status === 'fulfilled' ? result.value : { ...items[index]!.account, needsAuth: true })
    },
    async activate(provider, accountID) {
      const accounts = await listAccounts()
      if (!accounts.some(account => account.provider === provider && account.id === accountID && !account.needsAuth)) throw new Error('Router account is unavailable.')
      await ctx.credential.activate({ credentialID: accountID })
      if (provider === 'openai') return settleOpenAI(ctx, accountID, await connections('openai'), known.get(accountID))
      return true
    },
  }
}

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const SETTLE_BUDGET_MS = 2_500

/**
 * OpenCode's OpenAI provider rebuilds its ChatGPT workspace header and endpoint asynchronously after an
 * account switch. Wait (bounded overall) until both match the new account. Returns false if that could
 * not be confirmed, so the caller can delay the retry instead of sending a mismatched request.
 */
async function settleOpenAI(ctx: Plugin.Context, accountID: string, items: { connection: CredentialConnection; account: Account }[], cached: StoredCredential | undefined): Promise<boolean> {
  const target = items.find(item => item.account.id === accountID)
  if (!target) return false
  const deadline = performance.now() + SETTLE_BUDGET_MS
  const remaining = (): number => deadline - performance.now()
  // Mirrors OpenCode's OpenAI provider, which derives the header only from `metadata.accountID`.
  let expected: string | undefined
  if (target.account.method === 'oauth') {
    let source: unknown = cached?.metadata
    if (!cached) {
      try {
        const value = await within(ctx.integration.connection.resolve(target.connection), Math.min(1_000, remaining()))
        if (value === TIMED_OUT) return false
        source = value?.type === 'oauth' ? value.metadata : undefined
      } catch { return false }
    }
    const account = metadata(source)?.accountID
    expected = typeof account === 'string' ? account : undefined
  }
  while (remaining() > 0) {
    try {
      const result = await within(ctx.provider.get({ providerID: 'openai' }), Math.min(500, remaining()))
      if (result === TIMED_OUT) return false
      const header = result.data.headers?.['chatgpt-account-id']
      const codex = result.data.settings?.baseURL === CODEX_BASE_URL
      if (target.account.method === 'key' ? header === undefined && !codex : header === expected && codex) return true
    } catch { return false }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

function controlled(config: RouterConfig, id: string): id is 'anthropic' | 'openai' {
  return (id === 'anthropic' || id === 'openai') && !!config.providers[id]
}

export const accountRouter: Plugin.Plugin = {
  id: 'zenox.account-router',
  async setup(ctx) {
    if (!/^2\.(?:[3-9]|[1-9]\d+)\./.test(ctx.app.version) && !/^2\.2\.(?:[5-9]|[1-9]\d+)(?:\D|$)/.test(ctx.app.version)) throw new Error('Account router requires OpenCode V2 2.2.5 or newer.')
    const configPath = typeof ctx.options.configPath === 'string' ? resolve(ctx.options.configPath) : defaultConfigPath()
    const config = await loadConfig(configPath)
    if (!config || !Object.keys(config.providers).length) return
    const statePath = defaultStatePath(configPath)
    if (resolve(statePath) === resolve(configPath)) throw new Error('Router preference and state paths must differ.')
    const host = createPluginHost(ctx, config)
    const token = Symbol('location')
    const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex')
    const pool = await acquirePool(configPath, statePath, config, fingerprint)
    pool.hosts.set(token, host)
    const { controller } = pool
    const registrations: { dispose(): Promise<void> }[] = []
    const safely = async (operation: () => Promise<unknown>): Promise<void> => { try { await operation() } catch { /* Keep provider errors authoritative; never print credential diagnostics. */ } }
    try {
      registrations.push(await ctx.provider.transform(editor => {
        for (const provider of PROVIDERS) if (config.providers[provider]) editor.update(provider, value => { value.settings = { ...value.settings, transport: 'http' } })
      }))
      registrations.push(await ctx.model.transform(editor => {
        for (const provider of PROVIDERS) if (config.providers[provider]) for (const model of editor.list(provider)) editor.update(provider, model.id, value => { value.settings = { ...value.settings, transport: 'http' } })
      }))
      registrations.push(await ctx.session.hook('prompt', event => safely(async () => {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (session.model && controlled(config, session.model.providerID)) await controller.initialize(session.model.providerID)
      })))
      registrations.push(await ctx.session.hook('http.request', event => safely(() => controller.onRequest(event, event.request))))
      registrations.push(await ctx.session.hook('http.response', event => safely(() => controller.onResponse(event, event.request, event.response))))
      registrations.push(await ctx.session.hook('retry', event => safely(() => controller.onRetry(event))))
      // The terminal UI part calls this to render `/router-status`; it never sends inference or switches accounts.
      registrations.push(await ctx.rpc.register(RouterRpc, {
        status: async input => {
          const refresh = typeof input === 'object' && input !== null && 'refresh' in input && input.refresh === true
          // Due checks only: monitoring still respects the polling interval and backoff.
          if (refresh) await within(Promise.all(PROVIDERS.filter(provider => config.providers[provider]).map(provider => controller.refresh(provider))), 8_000)
          let accounts: Account[] | undefined
          try { accounts = await host.listAccounts() } catch { accounts = undefined }
          const report = buildReport(config, controller.state, { now: Date.now(), accounts, live: true })
          return { text: formatReport(report), report }
        },
      }))
    } catch (error) {
      await Promise.all(registrations.map(registration => registration.dispose()))
      pool.hosts.delete(token)
      if (!pool.hosts.size) { clearInterval(pool.timer); controller.stop(); if (pools.get(configPath) === pool) pools.delete(configPath) }
      throw error
    }
    return async () => {
      await Promise.all(registrations.map(registration => registration.dispose()))
      pool.hosts.delete(token)
      if (!pool.hosts.size) { clearInterval(pool.timer); controller.stop(); if (pools.get(configPath) === pool) pools.delete(configPath) }
    }
  },
}

export default accountRouter
