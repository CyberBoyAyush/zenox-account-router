import { execFile } from 'node:child_process'
import { cleanLabel } from './display.js'
import type { Account, CredentialSource, ProviderID, StoredCredential } from './types.js'

export type CommandRunner = (executable: string, args: readonly string[]) => Promise<string>

export const runCommand: CommandRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
    if (error) reject(new Error('OpenCode command failed. Check installation, server connection, and sign-in.'))
    else resolve(stdout)
  })
})

function object(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function string(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined
}

function safeID(input: unknown): string | undefined {
  const value = string(input)
  return value && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : undefined
}

function rows(input: unknown, provider?: ProviderID): unknown[] {
  if (Array.isArray(input)) return input
  const root = object(input)
  if (!root) return []
  if (Array.isArray(root.accounts)) return root.accounts
  if (Array.isArray(root.credentials)) return root.credentials
  if (provider && root[provider]) return rows(root[provider], provider)
  if (root.id || root.accountID) return [root]
  return []
}

export function parseAccounts(input: unknown): Account[] {
  const result: Account[] = []
  const append = (row: Record<string, unknown>, provider: unknown, active: boolean): void => {
    if (provider !== 'anthropic' && provider !== 'openai') return
    if (row.type === 'env' || row.type === 'external') return
    if ([row.providerID, row.provider, row.integrationID].some(value => value !== undefined && value !== provider)) return
    const id = safeID(row.accountID ?? row.id)
    const auth = object(row.auth) ?? object(row.value) ?? object(row.credential)
    const method = row.method ?? (row.type === 'credential' ? auth?.type : row.type) ?? auth?.type
    if (!id || (method !== 'oauth' && method !== 'key' && method !== 'api')) return
    if (result.some(account => account.provider === provider && account.id === id)) return
    const needsAuth = row.needsAuth === true || row.status === 'needs_auth' || object(row.status)?.type === 'needs_auth' || object(row.status)?.status === 'needs_auth'
    result.push({ id, provider, label: cleanLabel(string(row.label) ?? string(row.name) ?? id), method: method === 'oauth' ? 'oauth' : 'key', active, ...(needsAuth ? { needsAuth: true } : {}) })
  }
  for (const entry of rows(input)) {
    const row = object(entry)
    if (!row) continue
    if (Array.isArray(row.connections)) {
      const provider = row.id
      if (provider !== 'anthropic' && provider !== 'openai') continue
      if ([row.providerID, row.provider, row.integrationID].some(value => value !== undefined && value !== provider)) continue
      for (const [index, entry] of row.connections.entries()) {
        const connection = object(entry)
        if (connection?.type !== 'credential') continue
        // The CLI orders all connections by activation; filtering must not change it.
        append(connection, provider, index === 0)
      }
    } else append(row, row.providerID ?? row.provider ?? row.integrationID, row.active === true)
  }
  return result
}

export function parseCredentials(input: unknown, provider: ProviderID): StoredCredential[] {
  const result: StoredCredential[] = []
  for (const entry of rows(input, provider)) {
    const row = object(entry)
    if (!row || (row.providerID !== undefined && row.providerID !== provider) || (row.provider !== undefined && row.provider !== provider) || (row.integrationID !== undefined && row.integrationID !== provider)) continue
    const auth = object(row.auth) ?? object(row.value) ?? object(row.credential) ?? row
    const account = parseAccounts([{ ...row, provider, method: row.method ?? row.type ?? auth.type }])[0]
    if (!account) continue
    const credential: StoredCredential = { ...account }
    const access = string(auth.access) ?? string(auth.accessToken)
    const key = string(auth.key) ?? string(auth.apiKey)
    if (account.method === 'oauth' && access) credential.access = access
    if (account.method === 'key' && key) credential.key = key
    const expires = auth.expiresAt ?? auth.expires
    if (typeof expires === 'number' && Number.isFinite(expires) && expires >= 0) credential.expiresAt = expires
    const metadata = object(row.metadata) ?? object(auth.metadata)
    if (metadata) {
      const allowed: Record<string, unknown> = {}
      for (const name of ['accountId', 'accountID', 'account_id', 'chatgpt_account_id', 'organizationId', 'organizationID', 'workspaceId', 'workspaceID', 'plan', 'subscriptionType']) {
        const value = safeID(metadata[name])
        if (value) allowed[name] = value
      }
      for (const name of ['is_fedramp', 'isFedramp', 'chatgpt_account_is_fedramp']) if (typeof metadata[name] === 'boolean') allowed[name] = metadata[name]
      if (Object.keys(allowed).length) credential.metadata = allowed
    }
    if (!result.some(value => value.id === credential.id)) result.push(credential)
  }
  return result
}

export function createCredentialSource(options: { server?: string; executable?: string; runCommand?: CommandRunner } = {}): CredentialSource {
  const execute = options.runCommand ?? runCommand
  const executable = options.executable ?? 'opencode'
  if (options.server) {
    let url: URL
    try { url = new URL(options.server) } catch { throw new Error('Invalid OpenCode server URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid OpenCode server URL.')
  }
  const serverArgs = options.server ? ['--server', options.server] : []
  let checked: Promise<void> | undefined
  const check = (): Promise<void> => checked ??= (async () => {
    let version: string
    try { version = await execute(executable, ['--version']) } catch { throw new Error('Unable to check OpenCode version. OpenCode 2.2.5 or newer V2 is required.') }
    const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(version.trim())
    if (!match || Number(match[1]) !== 2 || Number(match[2]) < 2 || (Number(match[2]) === 2 && Number(match[3]) < 5)) throw new Error('OpenCode 2.2.5 or newer V2 is required.')
  })()
  const read = async (args: string[]): Promise<unknown> => {
    await check()
    try { return JSON.parse(await execute(executable, [...args, ...serverArgs])) as unknown } catch { throw new Error('Unable to read OpenCode accounts. Check server connection and sign-in.') }
  }
  return {
    async listAccounts() { return parseAccounts(await read(['auth', 'list', '--format', 'json'])) },
    async readCredentials(provider) {
      if (provider !== 'anthropic' && provider !== 'openai') throw new Error('Unsupported credential provider.')
      return parseCredentials(await read(['auth', 'export', provider]), provider)
    },
  }
}
