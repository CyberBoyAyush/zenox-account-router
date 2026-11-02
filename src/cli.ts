#!/usr/bin/env node
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultConfigPath, defaultStatePath, loadConfig, readState, saveState } from './config.js'
import { cleanLabel, displayAccounts, displayStatus } from './display.js'
import { createCredentialSource } from './opencode.js'
import { runSetup } from './setup.js'
import { PROVIDERS } from './types.js'
import type { Account, CredentialSource, ProviderConfig, RouterState, UsageSnapshot } from './types.js'

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

type InitialChoice = (config: ProviderConfig, accounts: Account[], usage: UsageSnapshot[], now: number) => { accountID?: string; reason: string }

export async function runCLI(args = process.argv.slice(2), dependencies: { source?: CredentialSource; output?: (text: string) => void; now?: () => number; fetch?: typeof globalThis.fetch; chooseInitial?: InitialChoice } = {}): Promise<void> {
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
  if (options.command === 'accounts') {
    const accounts = await source.listAccounts()
    output(options.json ? JSON.stringify(accounts.map(account => ({ id: account.id, provider: account.provider, label: cleanLabel(account.label), method: account.method, active: account.active, needsAuth: account.needsAuth === true })), null, 2) : displayAccounts(accounts))
    return
  }
  const configPath = options.config ?? defaultConfigPath()
  const config = await loadConfig(configPath)
  if (!config) throw new Error('Router configuration not found. Run setup first.')
  const statePath = defaultStatePath(configPath)
  if (resolve(configPath) === resolve(statePath)) throw new Error('Router configuration and state paths must differ.')
  const state = await readState(statePath)
  const now = (dependencies.now ?? Date.now)()
  if (options.refresh) {
    const { adapters } = await import('./providers/index.js')
    for (const provider of PROVIDERS) {
      const settings = config.providers[provider]
      if (!settings) continue
      const credentials = await source.readCredentials(provider)
      for (const credential of credentials) {
        if (credential.method !== 'oauth' || !settings.accountIDs.includes(credential.id)) continue
        const previous = state.usage[`${provider}:${credential.id}`]
        if (previous && (now - previous.checkedAt < config.pollIntervalMs || (previous.retryAt ?? 0) > now)) continue
        const usage = await adapters[provider].readUsage(credential, { now, fetch: dependencies.fetch ?? globalThis.fetch, signal: AbortSignal.timeout(15_000) })
        state.usage[`${provider}:${credential.id}`] = usage
      }
    }
    await saveState(state, statePath)
  }
  if (options.command === 'status') {
    output(options.json ? JSON.stringify({ config, state, refreshed: options.refresh }, null, 2) : displayStatus(config, state).replace('Saved state only; use --refresh to request live usage.', options.refresh ? 'Usage refreshed explicitly. No accounts were activated.' : 'Saved state only; use --refresh to request live usage.'))
    return
  }
  let chooseInitial = dependencies.chooseInitial
  if (!chooseInitial) {
    const modulePath = './policy.js'
    const policy: unknown = await import(modulePath)
    if (!policy || typeof policy !== 'object' || !('chooseInitial' in policy) || typeof policy.chooseInitial !== 'function') throw new Error('Routing policy is unavailable.')
    chooseInitial = policy.chooseInitial as InitialChoice
  }
  const choices: { provider: string; accountID?: string; reason: string }[] = []
  for (const provider of PROVIDERS) {
    const settings = config.providers[provider]
    if (!settings) continue
    const accounts: Account[] = settings.accountIDs.map(id => ({ id, provider, label: id, method: 'oauth', active: state.sticky[provider] === id }))
    if (settings.apiKeyAccountID) accounts.push({ id: settings.apiKeyAccountID, provider, label: settings.apiKeyAccountID, method: 'key', active: false })
    const usage = selectedUsage(state, provider, settings.accountIDs)
    choices.push({ provider, ...(settings.allowPaidFallback && settings.apiKeyAccountID && state.sticky[provider] === settings.apiKeyAccountID ? { accountID: settings.apiKeyAccountID, reason: 'Keep the saved paid fallback sticky; no automatic return to a subscription.' } : chooseInitial(settings, accounts, usage, now)) })
  }
  output(options.json ? JSON.stringify({ choices, refreshed: options.refresh, activated: false }, null, 2) : choices.map(choice => `${choice.provider}: ${cleanLabel(choice.accountID ?? 'no safe account')} — ${cleanLabel(choice.reason)} (dry run; not activated)`).join('\n'))
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
