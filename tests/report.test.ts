import { describe, expect, it, vi } from 'vitest'
import { emptyState, parseConfig } from '../src/config.js'
import { buildReport, displayWidth, duration, fit, formatReport, layoutReport, renderLines, usageTone } from '../src/report.js'
import type { StatusReport } from '../src/report.js'
import { RouterRpc } from '../src/rpc.js'
import { packageName, wrap } from '../src/setup.js'
import { ansiPaint, colorEnabled } from '../src/style.js'
import { createRouterTui, isReport, routerTui } from '../src/tui.js'
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
    // `a` is cooling down and `b` is in use, so only the paid key is left.
    expect(report.providers[0]!.next).toEqual({ label: 'API', paid: true })
    const text = formatReport(report)
    expect(text).toContain('ANTHROPIC   paid fallback ON')
    expect(text).toMatch(/○ Personal\s+limit hit · back in 3h 0m\n/)
    expect(text).toMatch(/● Work\s+ACTIVE\n/)
    expect(text).toMatch(/○ API\s+paid API key · last resort\n/)
    expect(text).toMatch(/5-hour {2}█{20} {2}100% {2}resets in 3h 0m/)
    expect(text).toMatch(/5-hour {2}░{20} {4}0% {2}not started/)
    expect(text).toMatch(/Weekly {2}█{4}░{16} {3}22% {2}resets in 5d 1h/)
    expect(text).toContain('→ If the current account runs out: API (paid, allowed models)')
    expect(text).not.toContain('Opus weekly')
    expect(text).toContain('checked 2m ago')
    expect(text).toContain('checked 1m ago')
    expect(text).not.toContain('--refresh')
    expect(text.split('\n').every(line => line.length <= 80)).toBe(true)
  })

  it('colours usage by how much is left and tags each account', () => {
    const lines = layoutReport(buildReport(config, state(), { now, accounts, live: true }))
    const tones = (pattern: RegExp) => lines.find(line => pattern.test(line.map(segment => segment.text).join('')))!.map(segment => segment.tone)
    expect(tones(/100%/)).toContain('bad')
    expect(tones(/22%/)).toContain('good')
    expect(tones(/● Work/)).toEqual(expect.arrayContaining(['good', 'strong']))
    expect(tones(/limit hit/)).toContain('warn')
    expect([0, 69, 70, 89, 90, 100].map(usageTone)).toEqual(['good', 'good', 'warn', 'warn', 'bad', 'bad'])
  })

  it('without the live account list shows the router-activated account as IN USE and the snapshot hint for the CLI', () => {
    const report = buildReport(config, state(), { now, live: false })
    expect(report.liveAccounts).toBe(false)
    const text = formatReport(report, { title: true, cli: true })
    expect(text.split('\n')[0]).toBe('Zenox Account Router  ·  saved snapshot')
    expect(text).toMatch(/● Work\s+IN USE/)
    expect(text).not.toContain('ACTIVE')
    expect(text).toContain('Saved snapshot. Add --refresh for live numbers.')
  })

  it('explains paused routing, missing usage and non-ok states, and never contains secrets', () => {
    const value = emptyState()
    value.usage['anthropic:a'] = { provider: 'anthropic', accountID: 'a', checkedAt: now, status: 'expired', windows: [] }
    value.usage['anthropic:b'] = { provider: 'anthropic', accountID: 'b', checkedAt: now - 3_600_000, status: 'ok', windows: [
      { id: 'five_hour', label: '5-hour', usedPercent: 40, resetsAt: now - 1, durationSeconds: 18_000 },
      { id: 'seven_day', label: 'Weekly', usedPercent: null, resetsAt: null, durationSeconds: 604_800 },
    ] }
    const report = buildReport(config, value, { now, accounts: [...accounts.map(account => ({ ...account, active: false })), { id: 'manual', provider: 'anthropic', label: 'Manual pick', method: 'oauth', active: true }], live: false })
    const text = formatReport(report)
    expect(text).toContain('! Paused: "Manual pick" is active but not selected.')
    expect(text).toContain('sign-in token expired · OpenCode refreshes it when this account is used · just now')
    expect(text).toContain('reset since this check')
    expect(text).toMatch(/Weekly {2}·{20} {5}\? {2}not started/)
    expect(text).toContain('→ If the current account runs out: Personal')
    expect(formatReport(buildReport(parseConfig({ version: 1, providers: {} }), value, { now, live: true }))).toContain('npx zenox-account-router setup')
  })

  it('keeps long labels and every tag within 80 columns and says when nothing is left', () => {
    const long = parseConfig({ version: 1, providers: { openai: { accountIDs: ['x', 'y'], accountLabels: { x: 'A'.repeat(70), y: 'B'.repeat(70) }, favoriteAccountID: 'y' } } })
    const value = emptyState()
    value.cooldowns['openai:y'] = { until: now + 86_400_000 * 6, confirmedAt: now }
    const report = buildReport(long, value, { now, accounts: [{ id: 'x', provider: 'openai', label: 'x', method: 'oauth', active: true }, { id: 'y', provider: 'openai', label: 'y', method: 'oauth', active: false, needsAuth: true }], live: true })
    const text = formatReport(report)
    expect(text).toContain(`${'A'.repeat(35)}…`)
    expect(text).toContain(`${'B'.repeat(35)}… limit hit · back in 6d 0h\n      needs sign-in · ★ favorite\n`)
    expect(text).toContain('requests stop')
    expect(text.split('\n').every(line => line.length <= 80)).toBe(true)
    expect(text.includes('\x1b')).toBe(false)
  })

  it('measures and truncates by terminal columns, so CJK and emoji labels stay within 80 columns', () => {
    expect([displayWidth('abc'), displayWidth('日本'), displayWidth('👩‍💻'), displayWidth('é')]).toEqual([3, 4, 2, 1])
    expect(fit('日本語テキスト', 6)).toBe('日本… ')
    expect(displayWidth(fit('👩‍💻👩‍💻👩‍💻', 5))).toBe(5)
    const wide = parseConfig({ version: 1, providers: { anthropic: { accountIDs: ['x', 'y'], accountLabels: { x: '仕事用アカウント'.repeat(6), y: '🚀'.repeat(40) } } } })
    const value = emptyState()
    value.cooldowns['anthropic:x'] = { until: now + 3_600_000, confirmedAt: now }
    const text = formatReport(buildReport(wide, value, { now, accounts: [{ id: 'y', provider: 'anthropic', label: 'y', method: 'oauth', active: true }, { id: 'x', provider: 'anthropic', label: 'x', method: 'oauth', active: false, needsAuth: true }], live: true }))
    expect(text.split('\n').every(line => displayWidth(line) <= 80)).toBe(true)
  })

  it('offers the paid key as next only when the controller could really use it', () => {
    const value = state()
    value.cooldowns['anthropic:a'] = { until: now + 3_600_000, confirmedAt: now }
    const next = (list: Account[]) => buildReport(config, value, { now, accounts: list, live: true }).providers[0]!.next
    expect(next(accounts)).toEqual({ label: 'API', paid: true })
    // A subscription that needs sign-in blocks paid fallback in the controller.
    expect(next(accounts.map(account => account.id === 'a' ? { ...account, needsAuth: true } : account))).toBeNull()
    expect(next(accounts.map(account => account.id === 'key' ? { ...account, needsAuth: true } : account))).toBeNull()
    expect(formatReport(buildReport(config, value, { now, accounts, live: true }))).toContain('→ If the current account runs out: API (paid, allowed models)')
  })

  it('paints segments with ANSI only when colour is allowed', () => {
    expect(ansiPaint({ text: 'ok', tone: 'good' })).toBe('\x1b[32mok\x1b[0m')
    expect(ansiPaint({ text: '  ', tone: 'good' })).toBe('  ')
    expect(ansiPaint({ text: 'plain' })).toBe('plain')
    expect(renderLines([[{ text: 'a', tone: 'bad' }, { text: ' b ' }]], ansiPaint)).toBe('\x1b[31ma\x1b[0m b')
    expect(colorEnabled({ isTTY: true }, {})).toBe(true)
    expect(colorEnabled({ isTTY: false }, {})).toBe(false)
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true)
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true)
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false)
    expect(colorEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
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
  const report: StatusReport = buildReport(config, state(), { now, accounts, live: true })
  function harness(status: (input: unknown, options: unknown) => Promise<unknown>, loadView?: () => Promise<{ showStatusDialog: (context: unknown, report: StatusReport) => void }>) {
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
    const plugin = loadView ? createRouterTui(loadView as Parameters<typeof createRouterTui>[0]) : routerTui
    void plugin.setup(context as unknown as Parameters<typeof routerTui.setup>[0])
    return { commands, modes, alert, set, toast, rpc, context }
  }

  it('registers /router-status (and /router) in the palette and opens the themed dialog with the server report', async () => {
    const status = vi.fn(async () => ({ text: 'REPORT TEXT', report }))
    const showStatusDialog = vi.fn()
    const h = harness(status, async () => ({ showStatusDialog }))
    expect(h.commands).toHaveLength(1)
    // Slash commands are only reachable from the prompt in the global keymap mode (verified in the real TUI).
    expect(h.modes).toEqual(['global'])
    expect(h.commands[0]).toMatchObject({ id: 'zenox.router.status', palette: true, slash: { name: 'router-status', aliases: ['router'] } })
    await h.commands[0]!.run()
    expect(status).toHaveBeenCalledWith({ refresh: true }, { location: { directory: '/work' } })
    expect(showStatusDialog).toHaveBeenCalledExactlyOnceWith(h.context, report)
    expect(h.alert).not.toHaveBeenCalled()
  })

  it.each([
    ['the themed view cannot load', async () => { throw new Error('no OpenTUI') }, report],
    ['the server sends no structured report', async () => ({ showStatusDialog: vi.fn() }), {}],
  ] as const)('falls back to the plain large dialog when %s', async (_name, loadView, payload) => {
    const h = harness(async () => ({ text: 'REPORT TEXT', report: payload }), loadView)
    await h.commands[0]!.run()
    expect(h.alert).toHaveBeenCalledWith({ title: 'Zenox Account Router', message: 'REPORT TEXT' })
    expect(h.set).toHaveBeenCalledWith({ size: 'large' })
  })

  it('explains how to fix it when the server part is not running', async () => {
    const loadView = vi.fn(async () => ({ showStatusDialog: vi.fn() }))
    const h = harness(async () => { throw new Error('rpc.method_not_found') }, loadView)
    await h.commands[0]!.run()
    expect(loadView).not.toHaveBeenCalled()
    expect(h.alert.mock.calls[0]![0].message).toContain('not running on this OpenCode server')
    expect(h.alert.mock.calls[0]![0].message).toContain('npx zenox-account-router setup')
  })

  it('accepts only fully well-formed reports for the themed dialog', () => {
    expect(isReport(report)).toBe(true)
    expect(isReport(JSON.parse(JSON.stringify(report)))).toBe(true)
    const broken = (mutate: (value: StatusReport) => void): unknown => { const copy = structuredClone(report); mutate(copy); return copy }
    expect(isReport(broken(value => { (value.providers[0]!.accounts[0] as unknown as { label: number }).label = 1 }))).toBe(false)
    expect(isReport(broken(value => { (value.providers[0]!.accounts[0]!.usage as unknown as { windows: string }).windows = 'x' }))).toBe(false)
    expect(isReport(broken(value => { (value.providers[0] as unknown as { provider: string }).provider = 'other' }))).toBe(false)
    expect(isReport(broken(value => { (value as unknown as { liveAccounts?: boolean }).liveAccounts = undefined }))).toBe(false)
  })

  it('reports an unexpected server response in the plain dialog', async () => {
    const h = harness(async () => 'nope', async () => ({ showStatusDialog: vi.fn() }))
    await h.commands[0]!.run()
    expect(h.alert.mock.calls[0]![0].message).toBe('The router returned an unexpected response.')
  })
})
