import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJSONC } from 'jsonc-parser'
import { describe, expect, it, vi } from 'vitest'
import { appendPlugin, defaultPluginSpec, PACKAGE_NAME, runSetup } from '../src/setup.js'
import type { SetupPrompts } from '../src/setup.js'
import { appendLog, defaultConfig, LOG_LIMIT_BYTES, readLogTail, defaultConfigPath, defaultLogPath, defaultStatePath, emptyState, readActivity, loadConfig, parseConfig, readState, saveConfig, saveState } from '../src/config.js'
import { parseCLIArguments, runCLI } from '../src/cli.js'
import { describeError } from '../src/index.js'
import { formatDecision, localTimestamp } from '../src/display.js'
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
    expect(defaultConfig()).toEqual({ version: 1, pollIntervalMs: 600_000, idleTimeoutMs: 600_000, strategy: 'smart', providers: {} })
    expect(defaultConfigPath()).toMatch(/opencode\/account-router\.json$/)
    expect(defaultStatePath('/safe/custom.json')).toBe('/safe/custom.state.json')
    expect(defaultLogPath('/safe/custom.json')).toBe('/safe/custom.log')
  })

  it('writes the new routing keys only when they differ from the defaults, so older plugin versions can still read the file', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const plain = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(plain).sort()).toEqual(['idleTimeoutMs', 'pollIntervalMs', 'providers', 'version'])
    const loaded = await loadConfig(path)
    expect(loaded?.strategy).toBe('smart')
    // No override: the router uses OpenCode's cache.ttl or the provider default.
    expect(loaded?.cacheWindowMs).toBeUndefined()
    await saveConfig({ ...configured(), strategy: 'sticky', cacheWindowMs: 3_600_000 }, path)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ strategy: 'sticky', cacheWindowMs: 3_600_000 })
    expect(await loadConfig(path)).toMatchObject({ strategy: 'sticky', cacheWindowMs: 3_600_000 })
  }))

  it('defaults older configs to smart routing with an automatic cache window and validates both settings', () => {
    const older = parseConfig({ version: 1, providers: { anthropic: { accountIDs: ['a'] } } })
    expect(older.strategy).toBe('smart')
    expect(older.cacheWindowMs).toBeUndefined()
    expect(parseConfig({ version: 1, cacheWindowMs: 86_400_000, providers: {} }).cacheWindowMs).toBe(86_400_000)
    expect(parseConfig({ version: 1, strategy: 'sticky', cacheWindowMs: 3_600_000, providers: {} })).toMatchObject({ strategy: 'sticky', cacheWindowMs: 3_600_000 })
    for (const bad of [{ strategy: 'random' }, { strategy: 'SMART' }, { cacheWindowMs: 59_999 }, { cacheWindowMs: 86_400_001 }, { cacheWindowMs: 300_000.5 }]) {
      expect(() => parseConfig({ version: 1, providers: {}, ...bad }), JSON.stringify(bad)).toThrow()
    }
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
    expect(await defaultPluginSpec(published, directory)).toBe(`${PACKAGE_NAME}@latest`)
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

  it('treats any version tag or entry form of the same package as already installed', () => {
    const objectForm = '{"plugins":["zenox@latest",{"package":"zenox-account-router","options":{"configPath":"/x"}}]}'
    expect(appendPlugin(objectForm, 'zenox-account-router@latest')).toBe(objectForm)
    const pinned = '{"plugins":["zenox-account-router@0.1.0"]}'
    expect(appendPlugin(pinned, 'zenox-account-router@latest')).toBe(pinned)
    expect(parseJSONC(appendPlugin('{"plugins":["zenox@latest"]}', 'zenox-account-router@latest'))).toEqual({ plugins: ['zenox@latest', 'zenox-account-router@latest'] })
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
    expect(chooseInitial).toHaveBeenCalledWith(configured().providers.anthropic, expect.arrayContaining([expect.objectContaining({ id: 'oauth-a', method: 'oauth' })]), [], 1234, 'smart')
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ choices: [{ provider: 'anthropic', accountID: 'oauth-b', reason: 'best available usage' }], strategy: 'smart', refreshed: false, activated: false })
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
      const output = vi.fn()
      await runCLI(['status', '--config', path, '--refresh'], { source: injected, output, now: () => 1234, color: false })
      // Only to show which account OpenCode has active; it returns no secrets.
      expect(injected.listAccounts).toHaveBeenCalledTimes(1)
      expect(injected.readCredentials).toHaveBeenCalledExactlyOnceWith('anthropic')
      expect(readUsage).toHaveBeenCalledTimes(1)
      expect((await readState(defaultStatePath(path))).usage['anthropic:oauth-a']).toEqual(usage)
      expect(await readFile(defaultStatePath(path), 'utf8')).not.toMatch(/FAKE_ACCESS|FAKE_KEY|UNSELECTED_ACCESS/)
      expect(output.mock.calls[0]![0]).toContain('Refreshed 1 account. No account was switched.')
      // An explicit refresh within a minute of the last check, or during backoff, is skipped.
      await runCLI(['status', '--config', path, '--refresh'], { source: injected, output, now: () => 1234 + 30_000, color: false })
      expect(readUsage).toHaveBeenCalledTimes(1)
      expect(output.mock.calls[1]![0]).toContain('Refreshed 0 accounts; 1 checked under a minute ago or backing off.')
      // Unlike background polling, it does not wait for the full polling interval.
      await runCLI(['status', '--config', path, '--refresh'], { source: injected, output, now: () => 1234 + 61_000, color: false })
      expect(readUsage).toHaveBeenCalledTimes(2)
    } finally { readUsage.mockRestore() }
  }))

  it('prints a readable status with the live active account, colour only when enabled, and never IDs or secrets', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    const labelled = configured()
    labelled.providers.anthropic!.accountLabels = { 'oauth-a': 'Personal', 'oauth-b': 'Work' }
    await saveConfig(labelled, path)
    const state = emptyState()
    state.sticky.anthropic = 'oauth-b'
    state.usage['anthropic:oauth-a'] = { provider: 'anthropic', accountID: 'oauth-a', checkedAt: 1_000, status: 'ok', windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 95, resetsAt: 1_000 + 3_600_000, durationSeconds: 18_000 }] }
    await saveState(state, defaultStatePath(path))
    const output = vi.fn()
    const injected = source()
    await runCLI(['status', '--config', path], { source: injected, output, now: () => 61_000, color: false })
    const plain = output.mock.calls[0]![0] as string
    expect(plain.split('\n')[0]).toBe('Zenox Account Router  ·  saved snapshot')
    // OpenCode reports oauth-a as active even though the router last activated oauth-b.
    expect(plain).toMatch(/● Personal\s+ACTIVE/)
    expect(plain).toMatch(/5-hour {2}█{19}░ {3}95% {2}resets in 59m/)
    expect(plain).toContain('Saved snapshot. Add --refresh for live numbers.')
    expect(plain).toMatch(/\nLog: (?:…)?\S*router\.log\n/)
    expect(plain.split('\n').every(line => line.length <= 80)).toBe(true)
    expect(plain).not.toMatch(/oauth-[ab]/)
    expect(plain.includes('\x1b')).toBe(false)
    expect(injected.readCredentials).not.toHaveBeenCalled()
    await runCLI(['status', '--config', path], { source: injected, output, now: () => 61_000, color: true })
    expect(output.mock.calls[1]![0]).toContain('\x1b[31m███████████████████\x1b[0m')
    // If OpenCode cannot be asked, the router's own record is shown instead.
    const failing = { ...injected, listAccounts: vi.fn(async () => { throw new Error('offline') }) }
    await runCLI(['status', '--config', path], { source: failing, output, now: () => 61_000, color: false })
    expect(output.mock.calls[2]![0]).toMatch(/● Work\s+IN USE/)
  }))

  it('explains a dry run in words with account names and the next account, without switching', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const output = vi.fn()
    const injected = source()
    await runCLI(['dry-run', '--config', path], { source: injected, output, now: () => 1234, color: false })
    const text = output.mock.calls[0]![0] as string
    expect(text).toContain('Zenox Account Router  ·  dry run, nothing is switched')
    expect(text).toMatch(/Uses {5}Personal\n/)
    expect(text).toContain('Why      It is in use. Mid-conversation it stays until it runs out.')
    expect(text).toMatch(/Next {5}Work\n/)
    expect(text).toContain('Quiet    stays: no other account expires meaningfully sooner')
    expect(text).not.toMatch(/oauth-[ab]/)
    expect(injected.readCredentials).not.toHaveBeenCalled()
    const sticky = configured()
    sticky.strategy = 'sticky'
    await saveConfig(sticky, path)
    await runCLI(['dry-run', '--config', path], { source: injected, output, now: () => 1234, color: false })
    expect(output.mock.calls[1]![0]).toContain('Why      It is in use, so the router stays on it until it runs out.')
    expect(output.mock.calls[1]![0]).not.toContain('Quiet')
  }))

  it('dry-run shows where smart routing would move at the next quiet prompt, with the reason, without switching', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    await saveConfig(configured(), path)
    const now = 10_000_000
    const state = emptyState()
    const windows = (session: number, weekly: number) => [
      { id: 'five_hour', label: '5-hour', usedPercent: 10, resetsAt: now + session, durationSeconds: 18_000 },
      { id: 'seven_day', label: 'Weekly', usedPercent: 25, resetsAt: now + weekly, durationSeconds: 604_800 },
    ]
    // The user's real case: the standby account's 5-hour window expires two hours sooner.
    state.usage['anthropic:oauth-a'] = { provider: 'anthropic', accountID: 'oauth-a', checkedAt: now - 60_000, status: 'ok', windows: windows(13_320_000, 418_800_000) }
    state.usage['anthropic:oauth-b'] = { provider: 'anthropic', accountID: 'oauth-b', checkedAt: now - 60_000, status: 'ok', windows: windows(6_120_000, 345_600_000) }
    // JSON output stays offline, so it relies on the account the router last recorded.
    state.sticky.anthropic = 'oauth-a'
    await saveState(state, defaultStatePath(path))
    const output = vi.fn()
    const injected = source()
    await runCLI(['dry-run', '--config', path], { source: injected, output, now: () => now, color: false })
    const text = output.mock.calls[0]![0] as string
    expect(text).toContain('Quiet    moves to Work at the next cache-safe prompt')
    expect(text).toContain("Work's 5-hour window resets in 1h 42m, Personal's in 3h 42m")
    expect(injected.listAccounts).toHaveBeenCalled()
    expect(injected.readCredentials).not.toHaveBeenCalled()
    await runCLI(['dry-run', '--config', path, '--json'], { source: injected, output, now: () => now, color: false })
    // Offline JSON has no OpenCode names here (no saved labels), so the account is identified by ID.
    expect(JSON.parse(output.mock.calls[1]![0] as string)).toMatchObject({ strategy: 'smart', activated: false, atNextQuietPrompt: { anthropic: { label: 'oauth-b' } } })
    await runCLI(['status', '--config', path], { source: injected, output, now: () => now, color: false })
    expect(output.mock.calls[2]![0]).toMatch(/→ Next quiet prompt moves to: Work\n/)
    expect((output.mock.calls[2]![0] as string).split('\n').every(line => line.length <= 80)).toBe(true)
  }))

  it('explains whether a dry run would leave an active paid key for a subscription', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    const paid = configured()
    paid.providers.anthropic = { ...paid.providers.anthropic!, apiKeyAccountID: 'key-a', allowPaidFallback: true, apiKeyModels: ['claude-sonnet-5-5'] }
    await saveConfig(paid, path)
    const onKey: CredentialSource = { listAccounts: vi.fn(async () => accounts.map(account => ({ ...account, active: account.id === 'key-a' }))), readCredentials: vi.fn(async () => []) }
    const output = vi.fn()
    await runCLI(['dry-run', '--config', path], { source: onKey, output, now: () => 1234, color: false })
    expect(output.mock.calls.at(-1)![0]).toMatch(/Uses {5}Personal\n/)
    expect(output.mock.calls.at(-1)![0]).toContain('A subscription is usable again, so the next prompt leaves the paid key.')
    const state = emptyState()
    for (const id of ['oauth-a', 'oauth-b']) state.cooldowns[`anthropic:${id}`] = { until: 1234 + 3_600_000, confirmedAt: 1234 }
    await saveState(state, defaultStatePath(path))
    await runCLI(['dry-run', '--config', path], { source: onKey, output, now: () => 1234, color: false })
    expect(output.mock.calls.at(-1)![0]).toMatch(/Uses {5}API\n/)
    expect(output.mock.calls.at(-1)![0]).toContain('The paid key is in use until a subscription is usable again.')
  }))

  it('lists accounts grouped by provider with IDs on their own line', async () => {
    const output = vi.fn()
    await runCLI(['accounts'], { source: source(), output, color: false })
    const text = output.mock.calls[0]![0] as string
    expect(text).toMatch(/^ANTHROPIC\n {2}● Personal\s+subscription {2}ACTIVE\n {4}oauth-a\n/)
    expect(text).toMatch(/○ API\s+API key\n {4}key-a\n\nOPENAI\n/)
    expect(text.split('\n').every(line => line.length <= 80)).toBe(true)
    await runCLI(['accounts'], { source: { listAccounts: async () => [], readCredentials: async () => [] }, output, color: false })
    expect(output.mock.calls[1]![0]).toContain('/connect')
  })
})

describe('decision log and shared activity files', () => {
  it('appends owner-only single lines and rotates to <name>.1 past 1 MB, keeping the tail readable across both', async () => temporary(async directory => {
    const path = join(directory, 'account-router.log')
    await appendLog(path, 'first line\nwith an injected newline')
    expect(await readFile(path, 'utf8')).toBe('first line with an injected newline\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const line = 'x'.repeat(1_000)
    for (let index = 0; index < 1_100; index++) await appendLog(path, `${index} ${line}`)
    const rotated = (await readFile(`${path}.1`, 'utf8')).split('\n').filter(Boolean)
    const current = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect((await stat(`${path}.1`)).size).toBeGreaterThan(LOG_LIMIT_BYTES)
    expect((await stat(path)).size).toBeLessThan(LOG_LIMIT_BYTES)
    expect(rotated[0]).toBe('first line with an injected newline')
    expect(current.at(-1)).toMatch(/^1099 /)
    expect(rotated.length + current.length).toBe(1_101)
    // The tail spans both files when the current one is short.
    const tail = await readLogTail(path, current.length + 2)
    expect(tail).toHaveLength(current.length + 2)
    expect(tail!.at(-1)).toMatch(/^1099 /)
    expect(await readLogTail(join(directory, 'missing.log'), 5)).toBeNull()
  }))

  it('refuses to follow a symlinked log file', async () => temporary(async directory => {
    const target = join(directory, 'elsewhere.txt')
    await writeFile(target, 'keep me\n')
    const path = join(directory, 'account-router.log')
    await symlink(target, path)
    await expect(appendLog(path, 'hijack')).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('keep me\n')
  }))

  it('formats a decision as one line with local time, level, scope and event, and scrubs anything secret-shaped', () => {
    const at = Date.parse('2026-11-03T10:00:00Z')
    expect(localTimestamp(at)).toMatch(/^2026-11-0[34] \d\d:\d\d:00\.000 [+-]\d\d:\d\d$/)
    expect(formatDecision({ at, provider: 'anthropic', event: 'switch', from: 'Vranda', to: 'Team\n\u001b[31mred', reason: 'Because.' }))
      .toBe(`${localTimestamp(at)} | INFO  | anthropic | SWITCH | Vranda → Teamred | Because.`)
    expect(formatDecision({ at, provider: 'router', event: 'load-failed', level: 'error', reason: 'Old.' })).toBe(`${localTimestamp(at)} | ERROR | router | LOAD-FAILED | - | Old.`)
    expect(formatDecision({ at, provider: 'openai', event: 'no-switch', level: 'warn', from: 'Work', reason: 'Fine.' })).toBe(`${localTimestamp(at)} | WARN  | openai | NO-SWITCH | Work | Fine.`)
    const leaked = formatDecision({ at, provider: 'router', event: 'error', reason: 'Bearer sk-ant-oat01-abcdefghijklmnop and sk-proj-ABCDEFGHIJKLMN and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl and AbCdEf0123456789AbCdEf0123456789AbCdEf0123 in /Users/ayush/Coding/WebSite/tools/zenox-account-router with cred_198886d61001TEGckR0gAVLZMw' })
    expect(leaked).not.toMatch(/sk-ant|sk-proj|eyJhbGci|AbCdEf0123456789AbCdEf/)
    expect(leaked).toContain('Bearer [redacted]')
    expect(leaked).toContain('/Users/ayush/Coding/WebSite/tools/zenox-account-router')
    expect(leaked).toContain('cred_198886d61001TEGckR0gAVLZMw')
  })

  it('never moves saved activity backwards when several OpenCode processes share the state file', async () => temporary(async directory => {
    const path = join(directory, 'router.state.json')
    const newer = emptyState()
    newer.activity = { anthropic: 2_000, openai: 500 }
    await saveState(newer, path)
    const older = emptyState()
    older.activity = { anthropic: 1_000 }
    older.sticky.anthropic = 'b'
    await saveState(older, path)
    const saved = await readState(path)
    expect(saved.activity).toEqual({ anthropic: 2_000, openai: 500 })
    expect(saved.sticky.anthropic).toBe('b')
    expect(await readActivity(path)).toEqual({ anthropic: 2_000, openai: 500 })
    // Older state files without activity still load, and unreadable files yield nothing.
    await writeFile(path, JSON.stringify({ version: 1, usage: {}, cooldowns: {}, sticky: {} }))
    expect(await readState(path)).toEqual(emptyState())
    await writeFile(path, '{broken')
    expect(await readActivity(path)).toBeUndefined()
    expect(await readActivity(join(directory, 'missing.json'))).toBeUndefined()
  }))
})

describe('logs command', () => {
  it('prints the newest lines with the log path, colours warnings and errors, and supports --lines and --json', async () => temporary(async directory => {
    const path = join(directory, 'router.json')
    const output = vi.fn()
    await runCLI(['logs', '--config', path], { output, color: false })
    expect(output.mock.calls[0]![0]).toBe(`No router log yet at ${join(directory, 'router.log')}. It is written once OpenCode loads the router.`)
    const at = Date.parse('2026-11-03T10:00:00Z')
    for (const [index, event] of (['loaded', 'usage', 'switch', 'no-switch', 'error'] as const).entries()) {
      await appendLog(join(directory, 'router.log'), formatDecision({ at: at + index, provider: index ? 'anthropic' : 'router', event, level: event === 'no-switch' ? 'warn' : event === 'error' ? 'error' : 'info', reason: `line ${index}` }))
    }
    await runCLI(['logs', '--config', path, '--lines', '3'], { output, color: false })
    const text = output.mock.calls[1]![0] as string
    expect(text.split('\n')[0]).toBe(`Router log: ${join(directory, 'router.log')}`)
    expect(text.split('\n').slice(2).map(line => line.split(' | ').at(-1))).toEqual(['line 2', 'line 3', 'line 4'])
    await runCLI(['logs', '--config', path, '-n', '2'], { output, color: true })
    expect(output.mock.calls[2]![0]).toContain('\x1b[33m')
    expect(output.mock.calls[2]![0]).toContain('\x1b[31m')
    await runCLI(['logs', '--config', path, '--json'], { output })
    expect(JSON.parse(output.mock.calls[3]![0] as string)).toMatchObject({ path: join(directory, 'router.log'), lines: expect.arrayContaining([expect.stringContaining('line 0')]) })
  }))

  it('validates --lines', () => {
    for (const bad of [['logs', '--lines', '0'], ['logs', '--lines', 'ten'], ['logs', '-n'], ['status', '--lines', '5']]) {
      expect(() => parseCLIArguments(bad), bad.join(' ')).toThrow()
    }
    expect(parseCLIArguments(['logs', '-n', '200'])).toMatchObject({ command: 'logs', lines: 200 })
  })
})

describe('log file hardening', () => {
  it('tightens an existing log that others could read, and refuses a log it does not own', async () => temporary(async directory => {
    const path = join(directory, 'account-router.log')
    await writeFile(path, 'old\n', { mode: 0o644 })
    await chmod(path, 0o644)
    await appendLog(path, 'new')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toBe('old\nnew\n')
    const getuid = vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(123_456)
    try { await expect(appendLog(path, 'foreign')).rejects.toThrow('Cannot write router log safely.') } finally { getuid.mockRestore() }
  }))

  it('rotates exactly once under the lock, skips while another process holds it, and clears a stale lock', async () => temporary(async directory => {
    const path = join(directory, 'account-router.log')
    await writeFile(path, `${'y'.repeat(LOG_LIMIT_BYTES)}\n`, { mode: 0o600 })
    await writeFile(`${path}.lock`, '', { mode: 0o600 })
    await appendLog(path, 'while locked')
    // Another process is rotating: this writer leaves the file alone.
    await expect(stat(`${path}.1`)).rejects.toThrow()
    const stale = new Date(Date.now() - 120_000)
    await utimes(`${path}.lock`, stale, stale)
    await appendLog(path, 'clears stale lock')
    await expect(stat(`${path}.lock`)).rejects.toThrow()
    await appendLog(path, 'rotates now')
    expect((await stat(`${path}.1`)).size).toBeGreaterThan(LOG_LIMIT_BYTES)
    await expect(stat(`${path}.lock`)).rejects.toThrow()
    await appendLog(path, 'fresh file')
    expect(await readFile(path, 'utf8')).toBe('fresh file\n')
    // Concurrent writers past the limit rotate once and lose nothing.
    await writeFile(path, `${'z'.repeat(LOG_LIMIT_BYTES)}\n`, { mode: 0o600 })
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendLog(path, `parallel ${index}`)))
    const all = `${await readFile(`${path}.1`, 'utf8')}${await readFile(path, 'utf8').catch(() => '')}`
    for (let index = 0; index < 8; index++) expect(all).toContain(`parallel ${index}`)
  }))

  it('keeps only short plain error messages in ERROR lines', () => {
    expect(describeError(new Error('session store unavailable'))).toBe('Error: session store unavailable')
    expect(describeError(new TypeError('Cannot read properties of undefined (reading x)'))).toBe('TypeError: Cannot read properties of undefined (reading x)')
    for (const leaky of ['{"messages":[{"role":"user","content":"my secret plan"}]}', 'token=abc123 failed', 'request 9876543210 failed', 'x'.repeat(200), 'Bad\nnewline: "quoted"']) {
      expect(describeError(new Error(leaky)), leaky).toBe('Error (details withheld from the log)')
    }
    expect(describeError(undefined)).toBe('a non-Error value was thrown')
    expect(describeError(null)).toBe('a non-Error value was thrown')
    expect(describeError('string')).toBe('a non-Error value was thrown')
    const hostile = new Error('x')
    Object.defineProperty(hostile, 'message', { get() { throw new Error('boom') } })
    expect(describeError(hostile)).toBe('an unprintable error was thrown')
    const renamed = new Error('fine')
    renamed.name = '<script>'
    expect(describeError(renamed)).toBe('Error: fine')
  })
})
