import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJSONC } from 'jsonc-parser'
import { describe, expect, it, vi } from 'vitest'
import { appendPlugin, defaultPluginSpec, PACKAGE_NAME, runSetup } from '../src/setup.js'
import type { SetupPrompts } from '../src/setup.js'
import { defaultConfig, defaultConfigPath, defaultStatePath, emptyState, loadConfig, parseConfig, readState, saveConfig, saveState } from '../src/config.js'
import { runCLI } from '../src/cli.js'
import { adapters } from '../src/providers/index.js'
import type { Account, CredentialSource, RouterConfig } from '../src/types.js'

const accounts: Account[] = [
  { id: 'oauth-a', provider: 'anthropic', label: 'Personal', method: 'oauth', active: true },
  { id: 'oauth-b', provider: 'anthropic', label: 'Work', method: 'oauth', active: false },
  { id: 'key-a', provider: 'anthropic', label: 'API', method: 'key', active: false },
  { id: 'openai-a', provider: 'openai', label: 'OpenAI', method: 'oauth', active: false },
]

function source(): CredentialSource {
  return { listAccounts: vi.fn(async () => accounts), readCredentials: vi.fn(async () => { throw new Error('Setup must not export credentials') }) }
}

function prompts(answers: { multi?: (string[] | symbol)[]; select?: (string | symbol)[]; confirm?: (boolean | symbol)[]; text?: (string | symbol)[] } = {}): SetupPrompts {
  return {
    intro: vi.fn(), note: vi.fn(), outro: vi.fn(), cancel: vi.fn(), isCancel: (value): value is symbol => typeof value === 'symbol',
    multiselect: vi.fn(async () => answers.multi?.shift() ?? ['anthropic']),
    select: vi.fn(async options => { const answer = answers.select?.shift(); return answer === 'automatic' || answer === undefined ? options.options[0]!.value : answer }),
    confirm: vi.fn(async () => answers.confirm?.shift() ?? false),
    text: vi.fn(async () => answers.text?.shift() ?? '10'),
  }
}

async function temporary<T>(test: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'account-router-test-'))
  try { return await test(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

function configured(): RouterConfig {
  return { ...defaultConfig(), providers: { anthropic: { accountIDs: ['oauth-a', 'oauth-b'], allowPaidFallback: false, apiKeyModels: [] } } }
}

describe('strict and private configuration', () => {
  it('has safe defaults and adjacent state paths', () => {
    expect(defaultConfig()).toEqual({ version: 1, pollIntervalMs: 600_000, idleTimeoutMs: 600_000, providers: {} })
    expect(defaultConfigPath()).toMatch(/opencode\/account-router\.json$/)
    expect(defaultStatePath('/safe/custom.json')).toBe('/safe/custom.state.json')
  })

  it('defaults paid fallback to false without adding unselected providers', () => {
    const result = parseConfig({ version: 1, providers: { anthropic: { accountIDs: ['a'] } } })
    expect(result.providers).toEqual({ anthropic: { accountIDs: ['a'], allowPaidFallback: false, apiKeyModels: [] } })
  })

  it('rejects unknown fields, invalid intervals, duplicate IDs, invalid favorites and unsafe paid defaults', () => {
    const base = configured()
    for (const bad of [
      { ...base, token: 'SECRET' }, { ...base, pollIntervalMs: 299_999 }, { ...base, pollIntervalMs: 3_600_001 },
      { ...base, providers: { anthropic: { accountIDs: [] } } },
      { ...base, providers: { anthropic: { accountIDs: ['a', 'a'] } } },
      { ...base, providers: { anthropic: { accountIDs: ['a'], favoriteAccountID: 'b' } } },
      { ...base, providers: { anthropic: { accountIDs: ['a'], apiKeyAccountID: 'a' } } },
      { ...base, providers: { anthropic: { accountIDs: ['a'], apiKeyAccountID: 'key', allowPaidFallback: true } } },
      { ...base, providers: { unknown: { accountIDs: ['a'] } } },
      { ...base, providers: { anthropic: { accountIDs: ['a'], access: 'SECRET' } } },
    ]) expect(() => parseConfig(bad)).toThrow('Invalid account-router configuration')
  })

  it('writes atomically with private permissions and loads absent files as null', async () => temporary(async directory => {
    const path = join(directory, 'new', 'account-router.json')
    expect(await loadConfig(path)).toBeNull()
    await saveConfig(configured(), path)
    expect(await loadConfig(path)).toEqual(configured())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'new'))).mode & 0o777).toBe(0o700)
    expect(await readdir(join(directory, 'new'))).toEqual(['account-router.json'])
    await writeFile(path, '{"token":"SECRET"}')
    await expect(loadConfig(path)).rejects.toThrow('Invalid account-router configuration.')
  }))

  it('rejects symlink files and symlink ancestors without touching their destination', async () => temporary(async directory => {
    const target = join(directory, 'target.json')
    await writeFile(target, 'ORIGINAL')
    const link = join(directory, 'link.json')
    await symlink(target, link)
    await expect(saveConfig(configured(), link)).rejects.toThrow('Unsafe configuration path.')
    await expect(loadConfig(link)).rejects.toThrow('Unsafe configuration path.')
    await symlink(directory, join(directory, 'linked-directory'))
    await expect(saveConfig(configured(), join(directory, 'linked-directory', 'new.json'))).rejects.toThrow('Unsafe configuration path.')
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL')
  }))

  it('persists only whitelisted state fields and refuses config overwrite', async () => temporary(async directory => {
    const statePath = join(directory, 'state.json')
    expect(await readState(statePath)).toEqual(emptyState())
    const state = { ...emptyState(), access: 'SECRET', usage: { 'anthropic:oauth-a': { provider: 'anthropic' as const, accountID: 'oauth-a', checkedAt: 1, status: 'ok' as const, windows: [], refresh: 'REFRESH' } } }
    await saveState(state, statePath)
    expect(await readFile(statePath, 'utf8')).not.toMatch(/SECRET|REFRESH|access|refresh/)
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    const configPath = join(directory, 'custom.json')
    await saveConfig(configured(), configPath)
    await expect(saveState(emptyState(), configPath)).rejects.toThrow('Refusing to overwrite a non-state file.')
    await expect(saveState(emptyState(), join(directory, 'account-router.json'))).rejects.toThrow('State path cannot overwrite router configuration.')
    expect(await loadConfig(configPath)).toEqual(configured())
  }))
})

describe('default plugin spec for installation', () => {
  it('registers the published package from npx/npm installs, the checkout path locally, and nothing otherwise', async () => temporary(async directory => {
    const published = join(directory, '_npx', 'abc', 'node_modules', PACKAGE_NAME)
    const checkout = join(directory, 'checkout')
    const other = join(directory, 'other')
    for (const [root, name] of [[published, PACKAGE_NAME], [checkout, PACKAGE_NAME], [other, 'something-else']] as const) {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify({ name }))
    }
    expect(await defaultPluginSpec(published, directory)).toBe(PACKAGE_NAME)
    expect(await defaultPluginSpec(checkout, checkout)).toBe(checkout)
    expect(await defaultPluginSpec(checkout, directory)).toBeUndefined()
    expect(await defaultPluginSpec(other, other)).toBeUndefined()
    expect(await defaultPluginSpec(join(directory, 'missing'), directory)).toBeUndefined()
  }))
})

describe('JSONC plugin installation', () => {
  it('appends after existing plugins while preserving comments, settings and object entries', () => {
    const original = '{\n  // Keep this setting\n  "model": "anthropic/model",\n  "plugins": [\n    // Auth first\n    { "package": "auth-plugin", "options": { "keep": true } },\n    "other-plugin",\n  ],\n}\n'
    const updated = appendPlugin(original, '/durable/router')
    expect(updated).toContain('// Keep this setting')
    expect(updated).toContain('// Auth first')
    expect(parseJSONC(updated)).toEqual({ model: 'anthropic/model', plugins: [{ package: 'auth-plugin', options: { keep: true } }, 'other-plugin', '/durable/router'] })
    expect(appendPlugin(updated, '/durable/router')).toBe(updated)
  })

  it('does not duplicate object-form plugin references or mutate invalid configurations', () => {
    const original = '{"plugins":[{"package":"/durable/router","options":{"enabled":true}}]}'
    expect(appendPlugin(original, '/durable/router')).toBe(original)
    expect(() => appendPlugin('{invalid SECRET}', '/router')).toThrow('Invalid OpenCode JSONC configuration')
    expect(() => appendPlugin('{"plugins":"wrong"}', '/router')).toThrow('OpenCode plugins must be an array')
  })
})

describe('consent-driven onboarding', () => {
  it('saves only chosen OAuth accounts, no unselected providers and no credentials', async () => temporary(async directory => {
    const configPath = join(directory, 'router.json')
    const injected = source()
    const ui = prompts({ multi: [['anthropic'], ['oauth-a', 'oauth-b']], select: ['oauth-b'], confirm: [false, true, false], text: ['10'] })
    const result = await runSetup({ configPath, pluginSpec: '/durable/router', source: injected, prompts: ui })
    expect(result?.providers).toEqual({ anthropic: { accountIDs: ['oauth-a', 'oauth-b'], accountLabels: { 'oauth-a': 'Personal', 'oauth-b': 'Work' }, favoriteAccountID: 'oauth-b', allowPaidFallback: false, apiKeyModels: [] } })
    expect(injected.readCredentials).not.toHaveBeenCalled()
    expect(await loadConfig(configPath)).toEqual(result)
    expect(await readFile(configPath, 'utf8')).not.toMatch(/access|refresh|key-a/)
  }))

  it('requires separate billing approval and a concrete model allowlist for API fallback', async () => temporary(async directory => {
    const ui = prompts({ multi: [['anthropic'], ['oauth-a']], select: ['automatic', 'key-a'], confirm: [true, true, true, false], text: ['claude-model-a,claude-model-b', '5'] })
    const result = await runSetup({ configPath: join(directory, 'router.json'), pluginSpec: '/durable/router', source: source(), prompts: ui })
    expect(result?.providers.anthropic).toEqual({ accountIDs: ['oauth-a'], accountLabels: { 'oauth-a': 'Personal', 'key-a': 'API' }, apiKeyAccountID: 'key-a', allowPaidFallback: true, apiKeyModels: ['claude-model-a', 'claude-model-b'] })
    expect(result?.pollIntervalMs).toBe(300_000)
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('provider-global'), initialValue: false }))
  }))

  it('keeps paid routing disabled when billing consent is denied', async () => temporary(async directory => {
    const ui = prompts({ multi: [['anthropic'], ['oauth-a']], select: ['automatic', 'key-a'], confirm: [true, false, true, false], text: ['10'] })
    const result = await runSetup({ configPath: join(directory, 'router.json'), pluginSpec: '/durable/router', source: source(), prompts: ui })
    expect(result?.providers.anthropic?.allowPaidFallback).toBe(false)
    expect(result?.providers.anthropic?.apiKeyAccountID).toBeUndefined()
  }))

  it('cancels cleanly before any config, directory, or backup write', async () => temporary(async directory => {
    const ui = prompts({ multi: [['anthropic'], ['oauth-a']], select: ['automatic'], confirm: [false, true, Symbol('cancel')], text: ['10'] })
    expect(await runSetup({ configPath: join(directory, 'new', 'router.json'), openCodeConfigPath: join(directory, 'opencode.jsonc'), pluginSpec: '/durable/router', source: source(), prompts: ui })).toBeNull()
    expect(await readdir(directory)).toEqual([])
    expect(ui.cancel).toHaveBeenCalled()
  }))

  it('rejects key-as-subscription selections and wildcard billing models before saving', async () => temporary(async directory => {
    const invalid = prompts({ multi: [['anthropic'], ['key-a']] })
    await expect(runSetup({ configPath: join(directory, 'router.json'), source: source(), prompts: invalid })).rejects.toThrow('Invalid OAuth account selection.')
    const wildcard = prompts({ multi: [['anthropic'], ['oauth-a']], select: ['automatic', 'key-a'], confirm: [true, true], text: ['*'] })
    await expect(runSetup({ configPath: join(directory, 'router.json'), source: source(), prompts: wildcard })).rejects.toThrow('no wildcard')
    expect(await readdir(directory)).toEqual([])
  }))

  it('backs up existing JSONC privately, preserves auth plugins and installs idempotently', async () => temporary(async directory => {
    const path = join(directory, 'opencode.jsonc')
    const original = '{\n // Keep me\n "plugins": ["existing-auth"],\n "model": "keep/model"\n}\n'
    await writeFile(path, original)
    const run = () => runSetup({ configPath: join(directory, 'router.json'), openCodeConfigPath: path, pluginSpec: '/durable/router', source: source(), prompts: prompts({ multi: [['anthropic'], ['oauth-a']], select: ['automatic'], confirm: [false, true, true], text: ['10'] }) })
    await run()
    const backups = (await readdir(directory)).filter(name => name.includes('.backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]!), 'utf8')).toBe(original)
    expect((await stat(join(directory, backups[0]!))).mode & 0o777).toBe(0o600)
    const updated = await readFile(path, 'utf8')
    expect(updated).toContain('// Keep me')
    expect(parseJSONC(updated)).toEqual({ plugins: ['existing-auth', { package: '/durable/router', options: { configPath: join(directory, 'router.json') } }], model: 'keep/model' })
    await run()
    expect(await readFile(path, 'utf8')).toBe(updated)
    expect((await readdir(directory)).filter(name => name.includes('.backup-'))).toHaveLength(1)
  }))

  it('status reads saved sanitized state without any account or network request', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const injected = source()
    const output = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>()
    await runCLI(['status', '--config', path, '--json'], { source: injected, output, fetch })
    expect(injected.listAccounts).not.toHaveBeenCalled()
    expect(injected.readCredentials).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    const parsed: unknown = JSON.parse(output.mock.calls[0]![0] as string)
    expect(parsed).toEqual({ config: configured(), state: emptyState(), refreshed: false })
  }))

  it('dry-run is offline and delegates the selected accounts and saved usage to policy without activation', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const injected = source()
    const output = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const chooseInitial = vi.fn(() => ({ accountID: 'oauth-b', reason: 'best available usage' }))
    await runCLI(['dry-run', '--config', path, '--json'], { source: injected, output, fetch, chooseInitial, now: () => 1234 })
    expect(injected.listAccounts).not.toHaveBeenCalled()
    expect(injected.readCredentials).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(chooseInitial).toHaveBeenCalledWith(configured().providers.anthropic, expect.arrayContaining([expect.objectContaining({ id: 'oauth-a', method: 'oauth' })]), [], 1234)
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ choices: [{ provider: 'anthropic', accountID: 'oauth-b', reason: 'best available usage' }], refreshed: false, activated: false })
  }))

  it('fetches usage only with explicit refresh, only for selected OAuth accounts, and saves no credentials', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const injected: CredentialSource = {
      listAccounts: vi.fn(async () => accounts),
      readCredentials: vi.fn(async () => [
        { ...accounts[0]!, access: 'FAKE_ACCESS' },
        { ...accounts[2]!, key: 'FAKE_KEY' },
        { ...accounts[0]!, id: 'unselected', access: 'UNSELECTED_ACCESS' },
      ]),
    }
    const usage = { provider: 'anthropic' as const, accountID: 'oauth-a', checkedAt: 1234, status: 'ok' as const, windows: [] }
    const readUsage = vi.spyOn(adapters.anthropic, 'readUsage').mockResolvedValue(usage)
    try {
      await runCLI(['status', '--config', path, '--refresh'], { source: injected, output: vi.fn(), now: () => 1234 })
      expect(injected.listAccounts).not.toHaveBeenCalled()
      expect(injected.readCredentials).toHaveBeenCalledExactlyOnceWith('anthropic')
      expect(readUsage).toHaveBeenCalledTimes(1)
      expect((await readState(defaultStatePath(path))).usage['anthropic:oauth-a']).toEqual(usage)
      expect(await readFile(defaultStatePath(path), 'utf8')).not.toMatch(/FAKE_ACCESS|FAKE_KEY|UNSELECTED_ACCESS/)
    } finally { readUsage.mockRestore() }
  }))
})
