#!/usr/bin/env node
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultConfigPath, defaultStatePath, loadConfig, readState, saveState } from './config.js'
import { cleanLabel } from './display.js'
import { buildReport, fit, layoutReport, PROVIDER_NAMES, renderLines } from './report.js'
import type { Line } from './report.js'
import { createCredentialSource } from './opencode.js'
import { runSetup } from './setup.js'
import { ansiPaint, colorEnabled } from './style.js'
import { PROVIDERS } from './types.js'
import type { Account, CredentialSource, ProviderConfig, ProviderID, RouterState, UsageSnapshot } from './types.js'

interface CLIArguments {
  command: 'setup' | 'accounts' | 'status' | 'dry-run' | 'help'
  config?: string
  server?: string
  plugin?: string
  json: boolean
  refresh: boolean
}

export function parseCLIArguments(args: string[]): CLIArguments {
  const options: CLIArguments = { command: 'help', json: false, refresh: false }
  let commandSeen = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--json') options.json = true
    else if (arg === '--refresh') options.refresh = true
    else if (arg === '--help' || arg === '-h') options.command = 'help'
    else if (['--config', '--server', '--plugin'].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing option value.')
      if (arg === '--config') options.config = value
      else if (arg === '--server') options.server = value
      else options.plugin = value
    } else if (['setup', 'accounts', 'status', 'dry-run'].includes(arg) && !commandSeen) {
      options.command = arg as CLIArguments['command']
      commandSeen = true
    } else throw new Error('Unknown command or option. Use --help.')
  }
  if (options.plugin && options.command !== 'setup') throw new Error('--plugin is only available for setup.')
  if (options.refresh && !['status', 'dry-run'].includes(options.command)) throw new Error('--refresh is only available for status or dry-run.')
  if (options.json && options.command === 'setup') throw new Error('Setup is interactive and does not support --json.')
  return options
}

type InitialChoice = (config: ProviderConfig, accounts: Account[], usage: UsageSnapshot[], now: number) => { accountID?: string; reason: string; kind?: string }

export async function runCLI(args = process.argv.slice(2), dependencies: { source?: CredentialSource; output?: (text: string) => void; now?: () => number; fetch?: typeof globalThis.fetch; chooseInitial?: InitialChoice; color?: boolean } = {}): Promise<void> {
  const options = parseCLIArguments(args)
  const output = dependencies.output ?? console.log
  if (options.command === 'help') {
    output('zenox-account-router <setup|accounts|status|dry-run>\n\nCommands:\n  setup     Interactive onboarding: choose providers, accounts, favorite and optional paid fallback\n  accounts  List Anthropic/OpenAI accounts saved in OpenCode (no secrets)\n  status    Show saved usage and router state\n  dry-run   Show which account the policy would choose (never activates)\n\nOptions:\n  --config PATH  Router config (default: XDG_CONFIG_HOME/opencode/account-router.json)\n  --server URL   Use a specific OpenCode server for account commands\n  --json         Machine-readable, credential-free output\n  --refresh      Explicitly fetch live provider usage for status/dry-run\n  --plugin SPEC  Setup only: plugin package or durable local path to register\n\nStatus and dry-run are offline unless --refresh is supplied. No command activates accounts.')
    return
  }
  const source = dependencies.source ?? createCredentialSource({ server: options.server })
  if (options.command === 'setup') {
    await runSetup({ configPath: options.config, pluginSpec: options.plugin, server: options.server, source })
    return
  }
  const color = dependencies.color ?? colorEnabled()
  const render = (lines: Line[]): string => renderLines(lines, color ? ansiPaint : undefined)
  if (options.command === 'accounts') {
    const accounts = await source.listAccounts()
    output(options.json ? JSON.stringify(accounts.map(account => ({ id: account.id, provider: account.provider, label: cleanLabel(account.label), method: account.method, active: account.active, needsAuth: account.needsAuth === true })), null, 2) : render(accountLines(accounts)))
    return
  }
  const configPath = options.config ?? defaultConfigPath()
  const config = await loadConfig(configPath)
  if (!config) throw new Error('Router configuration not found. Run setup first.')
  const statePath = defaultStatePath(configPath)
  if (resolve(configPath) === resolve(statePath)) throw new Error('Router configuration and state paths must differ.')
  const state = await readState(statePath)
  const now = (dependencies.now ?? Date.now)()
  const notes: Line[] = []
  if (options.refresh) {
    const { adapters } = await import('./providers/index.js')
    let checked = 0, recent = 0
    for (const provider of PROVIDERS) {
      const settings = config.providers[provider]
      if (!settings) continue
      const credentials = await source.readCredentials(provider)
      for (const credential of credentials) {
        if (credential.method !== 'oauth' || !settings.accountIDs.includes(credential.id)) continue
        const previous = state.usage[`${provider}:${credential.id}`]
        // An explicit refresh skips the polling interval but never hammers the usage endpoints or ignores backoff.
        if (previous && (now - previous.checkedAt < MIN_REFRESH_MS || (previous.retryAt ?? 0) > now)) { recent++; continue }
        const usage = await adapters[provider].readUsage(credential, { now, fetch: dependencies.fetch ?? globalThis.fetch, signal: AbortSignal.timeout(15_000) })
        state.usage[`${provider}:${credential.id}`] = usage
        checked++
      }
    }
    await saveState(state, statePath)
    notes.push([{ text: `Refreshed ${checked} account${checked === 1 ? '' : 's'}${recent ? `; ${recent} checked under a minute ago or backing off` : ''}. No account was switched.`, tone: 'faint' }])
  }
  // Human output asks OpenCode which account is really active (local, no secrets); JSON stays fully offline.
  const live = options.json ? undefined : await liveAccounts(source)
  if (options.command === 'status') {
    output(options.json ? JSON.stringify({ config, state, refreshed: options.refresh }, null, 2) : render([...layoutReport(buildReport(config, state, { now, accounts: live, live: options.refresh }), { title: true, cli: true }), ...notes]))
    return
  }
  let chooseInitial = dependencies.chooseInitial
  if (!chooseInitial) {
    const modulePath = './policy.js'
    const policy: unknown = await import(modulePath)
    if (!policy || typeof policy !== 'object' || !('chooseInitial' in policy) || typeof policy.chooseInitial !== 'function') throw new Error('Routing policy is unavailable.')
    chooseInitial = policy.chooseInitial as InitialChoice
  }
  const choices: { provider: ProviderID; accountID?: string; reason: string; kind?: string }[] = []
  for (const provider of PROVIDERS) {
    const settings = config.providers[provider]
    if (!settings) continue
    const current = live ? live.find(account => account.provider === provider && account.active)?.id : state.sticky[provider]
    const listed = (id: string): Account | undefined => live?.find(account => account.provider === provider && account.id === id)
    const accounts: Account[] = settings.accountIDs.map(id => ({ id, provider, label: id, method: 'oauth', active: current === id, ...(listed(id)?.needsAuth ? { needsAuth: true } : {}) }))
    if (settings.apiKeyAccountID) accounts.push({ id: settings.apiKeyAccountID, provider, label: settings.apiKeyAccountID, method: 'key', active: false })
    const usage = selectedUsage(state, provider, settings.accountIDs)
    if (settings.allowPaidFallback && settings.apiKeyAccountID && current === settings.apiKeyAccountID) {
      // Mirrors the controller's reclaim: leave the key once a subscription is out of cooldown and not exhausted.
      const ready = accounts.filter(account => account.method === 'oauth' && !((state.cooldowns[`${provider}:${account.id}`]?.until ?? 0) > now))
      const back = chooseInitial(settings, ready, usage, now).accountID
      choices.push({ provider, ...(back ? { accountID: back, kind: 'return', reason: 'Return from the paid key to a usable subscription at the next prompt.' } : { accountID: settings.apiKeyAccountID, kind: 'paid', reason: 'Keep the paid key until a selected subscription is usable again.' }) })
      continue
    }
    choices.push({ provider, ...chooseInitial(settings, accounts, usage, now) })
  }
  if (options.json) {
    output(JSON.stringify({ choices, refreshed: options.refresh, activated: false }, null, 2))
    return
  }
  const report = buildReport(config, state, { now, accounts: live, live: options.refresh })
  const why: Record<string, string> = {
    sticky: 'It is in use, so the router stays on it until it runs out.',
    favorite: 'Nothing is in use yet, so it starts with your favorite.',
    best: 'Nothing is in use yet, so it picks the one with most room left.',
    paid: 'The paid key is in use until a subscription is usable again.',
    return: 'A subscription is usable again, so the next prompt leaves the paid key.',
    none: 'No selected subscription is usable right now.',
  }
  const lines: Line[] = [[{ text: 'Zenox Account Router', tone: 'strong' }, { text: '  ·  dry run, nothing is switched', tone: 'muted' }]]
  for (const choice of choices) {
    const settings = config.providers[choice.provider]!
    const provider = report.providers.find(item => item.provider === choice.provider)
    const label = choice.accountID ? cleanLabel(settings.accountLabels?.[choice.accountID] ?? live?.find(account => account.id === choice.accountID)?.label ?? choice.accountID) : undefined
    lines.push([], [{ text: PROVIDER_NAMES[choice.provider].toUpperCase(), tone: 'accent' }])
    lines.push([{ text: '  Uses     ', tone: 'muted' }, label ? { text: fit(label, 60).trimEnd(), tone: 'strong' } : { text: 'no account', tone: 'bad' }])
    lines.push([{ text: '  Why      ', tone: 'muted' }, { text: why[choice.kind ?? ''] ?? cleanLabel(choice.reason) }])
    if (provider && choice.kind === 'sticky') {
      lines.push([{ text: '  Next     ', tone: 'muted' }, provider.next ? { text: provider.next.paid ? `${fit(provider.next.label, 40).trimEnd()} (paid, allowed models)` : fit(provider.next.label, 60).trimEnd(), tone: provider.next.paid ? 'warn' : 'text' } : { text: 'nothing left, requests would stop', tone: 'bad' }])
    }
  }
  if (!options.refresh) lines.push([], [{ text: 'Based on saved usage. Add --refresh for live numbers.', tone: 'faint' }])
  output(render(lines))
}

const MIN_REFRESH_MS = 60_000

async function liveAccounts(source: CredentialSource): Promise<Account[] | undefined> {
  try { return await source.listAccounts({ timeoutMs: 5_000 }) } catch { return undefined }
}

/** `accounts` command: grouped by provider, IDs on a dimmed second line for copying into config. */
export function accountLines(accounts: Account[]): Line[] {
  if (!accounts.length) return [[{ text: 'No Anthropic or OpenAI accounts found. Connect one in OpenCode with /connect first.' }]]
  const lines: Line[] = []
  for (const provider of PROVIDERS) {
    const own = accounts.filter(account => account.provider === provider)
    if (!own.length) continue
    if (lines.length) lines.push([])
    lines.push([{ text: PROVIDER_NAMES[provider].toUpperCase(), tone: 'accent' }])
    for (const account of own) {
      const label = cleanLabel(account.label) || '(unnamed)'
      lines.push([
        { text: '  ' },
        { text: account.active ? '●' : '○', tone: account.active ? 'good' : 'faint' },
        { text: ` ${fit(label, 36)} `, tone: account.active ? 'strong' : 'text' },
        { text: account.method === 'oauth' ? 'subscription' : 'API key     ', tone: 'muted' },
        ...(account.active ? [{ text: '  ACTIVE', tone: 'good' as const }] : []),
        ...(account.needsAuth ? [{ text: '  needs sign-in', tone: 'bad' as const }] : []),
      ])
      lines.push([{ text: `    ${cleanLabel(account.id)}`, tone: 'faint' }])
    }
  }
  return lines
}

function selectedUsage(state: RouterState, provider: string, ids: string[]): UsageSnapshot[] {
  return Object.values(state.usage).filter(usage => usage.provider === provider && ids.includes(usage.accountID))
}

function isEntrypoint(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntrypoint()) {
  runCLI().catch(() => {
    console.error('Account router command failed. Check command options, configuration, OpenCode version (V2 ≥2.2.5), and sign-in. No credential diagnostics are printed.')
    process.exitCode = 1
  })
}
