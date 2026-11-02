import { describe, expect, it, vi } from 'vitest'
import { emptyState, parseConfig } from '../src/config.js'
import { buildReport, duration, formatReport } from '../src/report.js'
import { RouterRpc } from '../src/rpc.js'
import { packageName, wrap } from '../src/setup.js'
import { routerTui } from '../src/tui.js'
import type { Account, RouterState } from '../src/types.js'

const now = Date.parse('2026-11-02T12:00:00Z')
const config = parseConfig({
  version: 1,
  providers: {
    anthropic: {
      accountIDs: ['a', 'b'], accountLabels: { a: 'Personal', b: 'Work', key: 'API' },
      apiKeyAccountID: 'key', allowPaidFallback: true, apiKeyModels: ['claude-sonnet-5-5'],
    },
  },
})
const accounts: Account[] = [
  { id: 'b', provider: 'anthropic', label: 'Work', method: 'oauth', active: true },
  { id: 'a', provider: 'anthropic', label: 'Personal', method: 'oauth', active: false },
  { id: 'key', provider: 'anthropic', label: 'API', method: 'key', active: false },
]

function state(): RouterState {
  const value = emptyState()
  value.sticky.anthropic = 'b'
  value.cooldowns['anthropic:a'] = { until: now + 3 * 3_600_000, confirmedAt: now - 60_000 }
  value.usage['anthropic:a'] = { provider: 'anthropic', accountID: 'a', checkedAt: now - 120_000, status: 'ok', windows: [
    { id: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt: now + 3 * 3_600_000, durationSeconds: 18_000 },
    { id: 'seven_day_opus', label: 'Opus weekly', usedPercent: null, resetsAt: null, durationSeconds: 604_800, model: 'opus' },
  ] }
  value.usage['anthropic:b'] = { provider: 'anthropic', accountID: 'b', checkedAt: now - 30_000, status: 'ok', windows: [
    { id: 'five_hour', label: '5-hour', usedPercent: 0, resetsAt: null, durationSeconds: 18_000 },
    { id: 'seven_day', label: 'Weekly', usedPercent: 22, resetsAt: now + 5 * 86_400_000 + 3_600_000, durationSeconds: 604_800 },
  ] }
  return value
}

describe('status report', () => {
  it('marks active, sticky, cooldown and paid key accounts and hides unreported model windows', () => {
    const report = buildReport(config, state(), { now, accounts, live: true })
    expect(report.providers[0]!.accounts.map(account => [account.id, account.active, account.sticky, account.cooldownUntil !== undefined, account.method])).toEqual([
      ['a', false, false, true, 'oauth'], ['b', true, true, false, 'oauth'], ['key', false, false, false, 'key'],
    ])
    const text = formatReport(report)
    expect(text).toContain('Anthropic · paid fallback ON')
    expect(text).toContain('○ Personal  [cooling down 3h 0m]')
    expect(text).toContain('● Work  [ACTIVE]')
    expect(text).toContain('○ API  [paid API key]')
    expect(text).toMatch(/5-hour\s+█{14} 100% used · resets in 3h 0m/)
    expect(text).toMatch(/5-hour\s+░{14} 0%\s+used · not started/)
    expect(text).toMatch(/Weekly\s+█{3}░{11} 22%\s+used · resets in 5d 1h/)
    expect(text).not.toContain('Opus weekly')
    expect(text).toContain('checked 2m ago')
    expect(text).toContain('checked 1m ago')
    expect(text.split('\n').every(line => line.length <= 80)).toBe(true)
  })

  it('explains paused routing, missing usage and non-ok states, and never contains secrets', () => {
    const value = emptyState()
    value.usage['anthropic:a'] = { provider: 'anthropic', accountID: 'a', checkedAt: now, status: 'expired', windows: [] }
    const report = buildReport(config, value, { now, accounts: [...accounts.map(account => ({ ...account, active: false })), { id: 'manual', provider: 'anthropic', label: 'Manual pick', method: 'oauth', active: true }], live: false })
    const text = formatReport(report)
    expect(text).toContain('Routing paused: active account "Manual pick" is not in your selection.')
    expect(text).toContain('token expired (refreshed when needed)')
    expect(text).toContain('usage not checked yet')
    expect(text).toContain('Saved snapshot; use --refresh for live data.')
    expect(formatReport(buildReport(parseConfig({ version: 1, providers: {} }), value, { now, live: true }))).toContain('npx zenox-account-router setup')
  })

  it('formats durations compactly', () => {
    expect([0, 59_000, 90_000, 3_600_000 * 2 + 60_000 * 5, 86_400_000 * 3 + 3_600_000 * 4].map(duration)).toEqual(['now', '1m', '2m', '2h 5m', '3d 4h'])
  })
})

describe('setup text helpers', () => {
  it('wraps long lines within the width and keeps bullet and label indentation', () => {
    const text = wrap('• Usage is checked with Anthropic and OpenAI about every ten minutes while you are active in OpenCode.\n  Accounts:       Personal account, Work account, Another account, Yet another account\nshort', 40)
    const lines = text.split('\n')
    expect(lines.every(line => line.length <= 40)).toBe(true)
    expect(lines[0]!.startsWith('• Usage')).toBe(true)
    expect(lines[1]!.startsWith('  ') && !lines[1]!.startsWith('  •')).toBe(true)
    expect(lines.find(line => line.includes('Accounts:'))).toBeDefined()
    expect(lines.at(-1)).toBe('short')
    expect(text.replace(/\s+/gu, ' ')).toBe('• Usage is checked with Anthropic and OpenAI about every ten minutes while you are active in OpenCode. Accounts: Personal account, Work account, Another account, Yet another account short')
  })

  it('normalizes plugin specs to package names', () => {
    expect(['zenox-account-router', 'zenox-account-router@latest', 'zenox-account-router@0.1.0', '@ex-machina/opencode-anthropic-auth@next', '@scope/name', './local', '/abs/path', 'github:a/b'].map(packageName)).toEqual([
      'zenox-account-router', 'zenox-account-router', 'zenox-account-router', '@ex-machina/opencode-anthropic-auth', '@scope/name', './local', '/abs/path', 'github:a/b',
    ])
  })
})

describe('terminal UI part', () => {
  type Command = { id?: string; slash?: { name: string; aliases?: string[] }; palette?: true; run: (input?: string) => unknown }
  function harness(status: (input: unknown, options: unknown) => Promise<unknown>) {
    const commands: Command[] = []
    const modes: (string | undefined)[] = []
    const alert = vi.fn<(options: { title: string; message: string }) => Promise<void>>(async () => {})
    const set = vi.fn()
    const toast = vi.fn()
    const rpc = vi.fn((definition: { id: string }) => { expect(definition.id).toBe(RouterRpc.id); return { status } })
    const context = {
      location: { directory: '/work' },
      data: { location: { default: () => ({ directory: '/default' }) } },
      client: { rpc },
      ui: { dialog: { alert, set }, toast: { show: toast } },
      keymap: { layer: (factory: () => { mode?: string; commands?: Command[] }) => { const layer = factory(); modes.push(layer.mode); commands.push(...(layer.commands ?? [])) } },
    }
    void routerTui.setup(context as unknown as Parameters<typeof routerTui.setup>[0])
    return { commands, modes, alert, set, toast, rpc }
  }

  it('registers /router-status (and /router) in the palette and shows the server report in a large dialog', async () => {
    const status = vi.fn(async () => ({ text: 'REPORT TEXT', report: {} }))
    const h = harness(status)
    expect(h.commands).toHaveLength(1)
    // Slash commands are only reachable from the prompt in the global keymap mode (verified in the real TUI).
    expect(h.modes).toEqual(['global'])
    expect(h.commands[0]).toMatchObject({ id: 'zenox.router.status', palette: true, slash: { name: 'router-status', aliases: ['router'] } })
    await h.commands[0]!.run()
    expect(status).toHaveBeenCalledWith({ refresh: true }, { location: { directory: '/work' } })
    expect(h.alert).toHaveBeenCalledWith({ title: 'Zenox Account Router', message: 'REPORT TEXT' })
    expect(h.set).toHaveBeenCalledWith({ size: 'large' })
  })

  it('explains how to fix it when the server part is not running', async () => {
    const h = harness(async () => { throw new Error('rpc.method_not_found') })
    await h.commands[0]!.run()
    expect(h.alert.mock.calls[0]![0].message).toContain('not running on this OpenCode server')
    expect(h.alert.mock.calls[0]![0].message).toContain('npx zenox-account-router setup')
  })
})
