import * as clack from '@clack/prompts'
import { applyEdits, modify, parse as parseJSONC } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { atomicWriteText, defaultConfig, defaultConfigPath, parseConfig, readSafeText, saveConfig } from './config.js'
import { cleanLabel } from './display.js'
import { createCredentialSource } from './opencode.js'
import { PROVIDERS } from './types.js'
import type { CredentialSource, RouterConfig } from './types.js'

interface Choice { value: string; label: string; hint?: string }
export interface SetupPrompts {
  intro(message: string): void
  note(message: string, title?: string): void
  outro(message: string): void
  cancel(message: string): void
  isCancel(value: unknown): value is symbol
  multiselect(options: { message: string; options: Choice[]; required?: boolean }): Promise<string[] | symbol>
  select(options: { message: string; options: Choice[] }): Promise<string | symbol>
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>
  text(options: { message: string; defaultValue?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string | symbol>
}

const defaultPrompts: SetupPrompts = {
  intro: clack.intro, note: clack.note, outro: clack.outro, cancel: clack.cancel, isCancel: clack.isCancel,
  multiselect: options => clack.multiselect(options), select: options => clack.select(options),
  confirm: options => clack.confirm(options), text: options => clack.text(options),
}

export function appendPlugin(text: string, spec: string, options?: { configPath?: string; server?: string }): string {
  if (!spec.trim() || /[\p{Cc}\p{Cf}]/u.test(spec)) throw new Error('Invalid plugin specification.')
  const errors: ParseError[] = []
  const input: unknown = parseJSONC(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid OpenCode JSONC configuration; no changes made.')
  const config = input as Record<string, unknown>
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('OpenCode plugins must be an array; no changes made.')
  const plugins = (config.plugins ?? []) as unknown[]
  const index = plugins.findIndex(plugin => plugin === spec || (typeof plugin === 'object' && plugin !== null && 'package' in plugin && plugin.package === spec))
  const entry = options && Object.keys(options).length ? { package: spec, options } : spec
  if (index >= 0) {
    if (typeof entry === 'string') return text
    const previous = plugins[index]
    const previousOptions = typeof previous === 'object' && previous !== null && 'options' in previous && typeof previous.options === 'object' && previous.options !== null ? previous.options : {}
    const updated = { ...(typeof previous === 'object' && previous !== null ? previous : {}), package: spec, options: { ...previousOptions, ...options } }
    return applyEdits(text, modify(text, ['plugins', index], updated, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }))
  }
  const path: (string | number)[] = config.plugins === undefined ? ['plugins'] : ['plugins', plugins.length]
  return applyEdits(text, modify(text, path, config.plugins === undefined ? [entry] : entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    isArrayInsertion: config.plugins !== undefined,
  }))
}

export const PACKAGE_NAME = 'zenox-account-router'

/**
 * Plugin spec to register in OpenCode when `--plugin` is not given:
 * - run from an npm/npx/dlx install → the published package name (OpenCode installs it itself);
 * - run from this package's own checkout as the working directory → that durable local path;
 * - anything else → none (setup asks for `--plugin`).
 */
export async function defaultPluginSpec(root = dirname(dirname(fileURLToPath(import.meta.url))), cwd = process.cwd()): Promise<string | undefined> {
  let name: unknown
  try {
    const pkg: unknown = JSON.parse(await readSafeText(join(root, 'package.json')) ?? '{}')
    name = typeof pkg === 'object' && pkg !== null && 'name' in pkg ? pkg.name : undefined
  } catch { return undefined }
  if (name !== PACKAGE_NAME) return undefined
  if (/(?:^|[\\/])(?:node_modules|_npx|dlx)(?:[\\/]|$)/u.test(root)) return PACKAGE_NAME
  return resolve(cwd) === resolve(root) ? root : undefined
}

export async function runSetup(options: {
  configPath?: string
  openCodeConfigPath?: string
  pluginSpec?: string
  server?: string
  source?: CredentialSource
  prompts?: SetupPrompts
} = {}): Promise<RouterConfig | null> {
  const prompts = options.prompts ?? defaultPrompts
  const cancelled = Symbol('cancelled')
  const ask = async <T>(answer: Promise<T | symbol>): Promise<T> => {
    const value = await answer
    if (prompts.isCancel(value) || typeof value === 'symbol') throw cancelled
    return value
  }
  try {
    prompts.intro('Zenox Account Router — sticky subscription failover for OpenCode')
    prompts.note('Routing changes the active account globally for each selected provider, not per session. Managed providers use HTTP instead of WebSockets so rejected requests can be attributed safely. Usage checks send authenticated HTTPS requests directly to Anthropic/OpenAI. OpenCode credential exports are captured privately; refresh tokens are discarded and never saved. Paid API fallback is disabled unless you explicitly authorize provider-global billing. A favorite is used when an initial choice is needed, never to interrupt an already active selected account.', 'Scope and privacy')
    const accounts = await (options.source ?? createCredentialSource()).listAccounts()
    const available = PROVIDERS.filter(provider => accounts.some(account => account.provider === provider && account.method === 'oauth'))
    if (!available.length) { prompts.outro('No subscription OAuth accounts found. Sign in with OpenCode first, then run setup again.'); return null }
    const selected = await ask(prompts.multiselect({ message: 'Which providers should the router manage?', options: available.map(value => ({ value, label: value })), required: true }))
    if (!selected.length || selected.some(provider => !available.some(value => value === provider))) throw new Error('Select at least one available provider.')
    const config = defaultConfig()
    for (const provider of PROVIDERS) {
      if (!selected.includes(provider)) continue
      const oauth = accounts.filter(account => account.provider === provider && account.method === 'oauth')
      const accountIDs = await ask(prompts.multiselect({ message: `${provider}: select subscription OAuth accounts`, options: oauth.map(account => ({ value: account.id, label: cleanLabel(account.label), hint: account.needsAuth ? 'needs sign-in' : account.active ? 'active' : undefined })), required: true }))
      if (!accountIDs.length || accountIDs.some(id => !oauth.some(account => account.id === id))) throw new Error('Invalid OAuth account selection.')
      // A generated sentinel cannot collide with a real account ID.
      const automatic = `automatic-${randomUUID()}`
      const favorite = await ask(prompts.select({ message: `${provider}: favorite account`, options: [{ value: automatic, label: 'Automatic (best available usage)' }, ...oauth.filter(account => accountIDs.includes(account.id)).map(account => ({ value: account.id, label: cleanLabel(account.label) }))] }))
      config.providers[provider] = { accountIDs, accountLabels: Object.fromEntries(oauth.filter(account => accountIDs.includes(account.id)).map(account => [account.id, cleanLabel(account.label) || account.id])), ...(favorite !== automatic ? { favoriteAccountID: favorite } : {}), allowPaidFallback: false, apiKeyModels: [] }
      const keys = accounts.filter(account => account.provider === provider && account.method === 'key')
      if (keys.length && await ask(prompts.confirm({ message: `${provider}: configure an optional API-key fallback?`, initialValue: false }))) {
        const keyID = await ask(prompts.select({ message: `${provider}: choose the API-key account (not a subscription)`, options: keys.map(account => ({ value: account.id, label: cleanLabel(account.label) })) }))
        if (!keys.some(account => account.id === keyID)) throw new Error('Invalid API-key account selection.')
        const paid = await ask(prompts.confirm({ message: `Authorize PAID ${provider} API fallback? This changes provider-global routing and may bill API usage across all sessions.`, initialValue: false }))
        if (paid) {
          const models = await ask(prompts.text({ message: 'Explicit allowed API model IDs, comma-separated (no wildcard)', validate: validateModels }))
          const error = validateModels(models)
          if (error) throw new Error(error)
          config.providers[provider] = { ...config.providers[provider]!, accountLabels: { ...config.providers[provider]!.accountLabels, [keyID]: cleanLabel(keys.find(account => account.id === keyID)!.label) || keyID }, apiKeyAccountID: keyID, allowPaidFallback: true, apiKeyModels: models.split(',').map(value => value.trim()) }
        }
      }
    }
    const minutes = await ask(prompts.text({ message: 'Usage polling interval in minutes (5–60)', defaultValue: '10', placeholder: '10', validate: validateMinutes }))
    if (validateMinutes(minutes)) throw new Error('Polling interval must be between 5 and 60 minutes.')
    config.pollIntervalMs = Number(minutes) * 60_000
    const validated = parseConfig(config)
    prompts.note(Object.entries(validated.providers).map(([provider, settings]) => `${provider}: ${settings!.accountIDs.length} OAuth account(s), favorite ${cleanLabel(settings!.favoriteAccountID ?? 'automatic')}, paid fallback ${settings!.allowPaidFallback ? `AUTHORIZED; models: ${settings!.apiKeyModels.map(cleanLabel).join(', ')}` : 'OFF'}`).join('\n') + `\nPolling: ${Number(minutes)} minutes. No credentials will be stored.`, 'Review')
    if (!await ask(prompts.confirm({ message: 'Save this global router configuration?', initialValue: false }))) { prompts.outro('Cancelled; no files changed.'); return null }
    const configPath = options.configPath ?? defaultConfigPath()
    const spec = options.pluginSpec ?? await defaultPluginSpec()
    let installation: { path: string; original: string | null; updated: string } | undefined
    if (spec) {
      if (await ask(prompts.confirm({ message: 'Also append this router AFTER existing auth plugins in global OpenCode config? A private backup will be made.', initialValue: false }))) {
        const directory = dirname(defaultConfigPath())
        const jsonc = join(directory, 'opencode.jsonc')
        const json = join(directory, 'opencode.json')
        let path = options.openCodeConfigPath ?? jsonc
        let original = await readSafeText(path)
        if (!options.openCodeConfigPath && original === null) {
          const alternate = await readSafeText(json)
          if (alternate !== null) { path = json; original = alternate }
        }
        if (resolve(path) === resolve(configPath)) throw new Error('OpenCode and router configuration paths must be distinct.')
        installation = { path, original, updated: appendPlugin(original ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', spec, { configPath: resolve(configPath) }) }
      }
    } else prompts.note(`Plugin not installed automatically. Run via \`npx ${PACKAGE_NAME} setup\`, run from a local checkout, or pass --plugin <package-or-path>.`, 'Plugin installation')
    // All consent and validation complete before the first filesystem write.
    if (installation && installation.updated !== installation.original) {
      if (installation.original !== null) await atomicWriteText(`${installation.path}.backup-${randomUUID()}`, installation.original)
    }
    await saveConfig(validated, configPath)
    if (installation && installation.updated !== installation.original) await atomicWriteText(installation.path, installation.updated)
    prompts.outro(installation ? 'Router saved and plugin configured. OpenCode watches configuration changes. Use /reload after changing an existing router configuration.' : 'Router configuration saved. Plugin installation was not changed. Use /reload if the router is already loaded.')
    return validated
  } catch (error) {
    if (error === cancelled) { prompts.cancel('Cancelled; no files changed.'); return null }
    throw error
  }
}

function validateMinutes(value: string): string | undefined {
  return !/^\d+$/u.test(value) || Number(value) < 5 || Number(value) > 60 ? 'Enter whole minutes from 5 to 60.' : undefined
}

function validateModels(value: string): string | undefined {
  const models = value.split(',').map(model => model.trim())
  return models.length > 100 || models.some(model => !model || model.length > 256 || /[\s*\p{Cc}\p{Cf}]/u.test(model)) || new Set(models).size !== models.length ? 'Enter unique, explicit model IDs separated by commas; no wildcard.' : undefined
}
