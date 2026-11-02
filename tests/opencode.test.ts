import { describe, expect, it, vi } from 'vitest'
import { createCredentialSource, parseAccounts, parseCredentials } from '../src/opencode.js'
import type { CommandRunner } from '../src/opencode.js'
import { cleanLabel } from '../src/display.js'

const account = { id: 'a1', integrationID: 'anthropic', label: 'Personal', active: true, type: 'oauth' }

describe('private OpenCode credential access', () => {
  it('parses real integration-group account lists and uses the original first connection as active', () => {
    const input = [
      { id: 'anthropic', name: 'Anthropic', connections: [
        { type: 'credential', id: 'credA', label: 'Claude A', method: 'oauth' },
        { type: 'credential', id: 'credB', label: 'API', method: 'key' },
        { type: 'credential', id: 'credC', label: 'Claude C', method: 'oauth', status: { type: 'needs_auth', message: 'SECRET' } },
      ] },
      { id: 'openai', name: 'OpenAI', connections: [
        { type: 'credential', id: 'credD', label: 'ChatGPT', method: 'oauth' },
        { type: 'env', id: 'OPENAI_API_KEY', label: 'Environment', method: 'key', value: 'SECRET_KEY' },
      ] },
    ]
    expect(parseAccounts(input)).toEqual([
      { id: 'credA', provider: 'anthropic', label: 'Claude A', method: 'oauth', active: true },
      { id: 'credB', provider: 'anthropic', label: 'API', method: 'key', active: false },
      { id: 'credC', provider: 'anthropic', label: 'Claude C', method: 'oauth', active: false, needsAuth: true },
      { id: 'credD', provider: 'openai', label: 'ChatGPT', method: 'oauth', active: true },
    ])
    expect(JSON.stringify(parseAccounts(input))).not.toMatch(/SECRET|OPENAI_API_KEY/)
  })

  it('does not promote a credential when an environment connection is first, or trust conflicting providers', () => {
    expect(parseAccounts([
      { id: 'anthropic', connections: [
        { type: 'env', id: 'ANTHROPIC_API_KEY', method: 'key' },
        { type: 'credential', id: 'inactive', method: 'oauth' },
        { type: 'credential', id: 'wrong', integrationID: 'openai', method: 'oauth' },
        { type: 'credential', id: 'wrong2', providerID: 'anthropic', provider: 'openai', method: 'key' },
        { type: 'credential', id: 'external', method: 'external' },
        null,
      ] },
      { id: 'unknown', connections: [{ type: 'credential', id: 'other', method: 'oauth' }] },
      { id: 'openai', providerID: 'anthropic', connections: [{ type: 'credential', id: 'conflict', method: 'oauth' }] },
      { id: 'flat-env', providerID: 'anthropic', type: 'env', method: 'key' },
    ])).toEqual([{ id: 'inactive', provider: 'anthropic', label: 'inactive', method: 'oauth', active: false }])
  })

  it('reads real grouped lists and native export entries through the injected command runner', async () => {
    const expires = 1_800_000_000_123
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args[0] === '--version') return '2.2.5'
      if (args[1] === 'list') return JSON.stringify([{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential', id: 'credA', label: 'Claude A', method: 'oauth' }] }])
      return JSON.stringify([
        { id: 'credA', integrationID: 'anthropic', label: 'Claude A', active: true, value: { type: 'oauth', methodID: 'oauth-method', access: 'ACCESS', refresh: 'REFRESH', expires, metadata: { accountID: 'accountA' } } },
        { id: 'other', integrationID: 'openai', label: 'Other', active: true, value: { type: 'oauth', access: 'OTHER_ACCESS', refresh: 'OTHER_REFRESH', expires } },
      ])
    })
    const source = createCredentialSource({ runCommand: run })
    expect(await source.listAccounts()).toEqual([{ id: 'credA', provider: 'anthropic', label: 'Claude A', method: 'oauth', active: true }])
    const credentials = await source.readCredentials('anthropic')
    expect(credentials).toEqual([{ id: 'credA', provider: 'anthropic', label: 'Claude A', method: 'oauth', active: true, access: 'ACCESS', expiresAt: expires, metadata: { accountID: 'accountA' } }])
    expect(JSON.stringify(credentials)).not.toMatch(/REFRESH|OTHER_ACCESS|methodID/)
  })

  it('parses account summaries without passing credential fields through', () => {
    const input = { accounts: [
      { ...account, label: '\u001b[31mPersonal\u001b[0m\n', access: 'ACCESS', refresh: 'REFRESH' },
      { id: 'k1', providerID: 'openai', method: 'key', label: 'API', key: 'KEY' },
      { id: 'x1', providerID: 'other', method: 'oauth' },
      { ...account, id: '__proto__' },
    ] }
    expect(parseAccounts(input)).toEqual([
      { id: 'a1', provider: 'anthropic', label: 'Personal', method: 'oauth', active: true },
      { id: 'k1', provider: 'openai', label: 'API', method: 'key', active: false },
    ])
    expect(JSON.stringify(parseAccounts(input))).not.toMatch(/ACCESS|REFRESH|KEY/)
  })

  it('supports V2 credential entries and strips refresh and unknown metadata recursively', () => {
    const result = parseCredentials({ credentials: [{
      ...account,
      value: { type: 'oauth', access: 'ACCESS', refresh: 'REFRESH', expires: 1234, metadata: { accountId: 'acct-1', refresh: 'REFRESH', secret: 'SECRET', nested: { key: 'KEY' } } },
    }, {
      id: 'k1', integrationID: 'anthropic', label: 'API', value: { type: 'key', key: 'KEY', refresh: 'REFRESH' },
    }, {
      id: 'wrong', integrationID: 'openai', value: { type: 'oauth', access: 'WRONG', refresh: 'REFRESH' },
    }] }, 'anthropic')
    expect(result).toEqual([
      { id: 'a1', provider: 'anthropic', label: 'Personal', method: 'oauth', active: true, access: 'ACCESS', expiresAt: 1234, metadata: { accountId: 'acct-1' } },
      { id: 'k1', provider: 'anthropic', label: 'API', method: 'key', active: false, key: 'KEY' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/REFRESH|SECRET|WRONG/)
  })

  it('handles malformed and duplicate entries without widening provider selection', () => {
    expect(parseAccounts(null)).toEqual([])
    expect(parseCredentials({ openai: [{ ...account, provider: 'openai' }] }, 'anthropic')).toEqual([])
    expect(parseAccounts([account, account, { ...account, id: '\nunsafe' }, { ...account, type: 'external' }])).toHaveLength(1)
  })

  it('runs only argument-vector commands with selected server and a cached version check', async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) => args[0] === '--version' ? '2.2.5\n' : JSON.stringify([account]))
    const source = createCredentialSource({ executable: '/safe path/opencode', server: 'http://localhost:4096', runCommand: run })
    await source.listAccounts()
    await source.readCredentials('anthropic')
    expect(run.mock.calls).toEqual([
      ['/safe path/opencode', ['--version'], undefined],
      ['/safe path/opencode', ['auth', 'list', '--format', 'json', '--server', 'http://localhost:4096'], undefined],
      ['/safe path/opencode', ['auth', 'export', 'anthropic', '--server', 'http://localhost:4096'], undefined],
    ])
  })

  it.each(['1.9.9', '2.2.4', '3.0.0', 'unexpected SECRET'])('rejects incompatible version %s without exposing output', async version => {
    const run = vi.fn(async () => version)
    const source = createCredentialSource({ runCommand: run })
    await expect(source.listAccounts()).rejects.toThrow('OpenCode 2.2.5 or newer V2 is required.')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('passes a per-call timeout to every command and retries a version check that failed', async () => {
    let fail = true
    const run = vi.fn<CommandRunner>(async (_executable, args) => {
      if (args[0] === '--version') { if (fail) throw new Error('timed out'); return '\u001b[1mopencode\u001b[0m \u001b[2mv\u001b[0m2.2.5' }
      return '[]'
    })
    const source = createCredentialSource({ runCommand: run })
    await expect(source.listAccounts({ timeoutMs: 5_000 })).rejects.toThrow('Unable to check OpenCode version.')
    fail = false
    expect(await source.listAccounts({ timeoutMs: 5_000 })).toEqual([])
    expect(run.mock.calls.map(call => call[2])).toEqual([5_000, 5_000, 5_000])
  })

  it.each(['2.2.5', '2.2.6', '2.3.0'])('accepts compatible V2 version %s', async version => {
    const source = createCredentialSource({ runCommand: async (_exe, args) => args[0] === '--version' ? version : '[]' })
    expect(await source.listAccounts()).toEqual([])
  })

  it('replaces every subprocess failure or malformed output with generic diagnostics', async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return '2.2.5'
      throw new Error('stderr ACCESS REFRESH KEY')
    })
    await expect(createCredentialSource({ runCommand: run }).readCredentials('anthropic')).rejects.toThrow('Unable to read OpenCode accounts.')
    const invalid = createCredentialSource({ runCommand: async (_exe, args) => args[0] === '--version' ? '2.2.5' : 'invalid SECRET' })
    await expect(invalid.listAccounts()).rejects.toThrow('Unable to read OpenCode accounts.')
  })

  it('rejects unsafe server URLs without executing commands', () => {
    const run = vi.fn(async () => '')
    expect(() => createCredentialSource({ server: 'file:///private/secret', runCommand: run })).toThrow('Invalid OpenCode server URL.')
    expect(() => createCredentialSource({ server: 'https://user:secret@example.test', runCommand: run })).toThrow('Invalid OpenCode server URL.')
    expect(run).not.toHaveBeenCalled()
  })

  it('removes terminal control sequences, OSC links, bidi controls, and newlines', () => {
    expect(cleanLabel('\u001b]8;;https://example.test\u0007click\u001b]8;;\u0007\u001b[31mred\u001b[0m\n\u202e')).toBe('clickred')
  })
})
