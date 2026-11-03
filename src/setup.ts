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
import type { CredentialSource, ProviderID, RouterConfig } from './types.js'

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

/** npm package name without a version/tag suffix; local paths and other specs are returned unchanged. */
export function packageName(spec: string): string {
  if (/^(?:\.{0,2}\/|file:|[a-z]:\\|github:|git\+|https?:)/iu.test(spec)) return spec
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at > 0 ? spec.slice(0, at) : spec
}

export function appendPlugin(text: string, spec: string, options?: { configPath?: string; server?: string }): string {
  if (!spec.trim() || /[\p{Cc}\p{Cf}]/u.test(spec)) throw new Error('Invalid plugin specification.')
  const errors: ParseError[] = []
  const input: unknown = parseJSONC(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid OpenCode JSONC configuration; no changes made.')
  const config = input as Record<string, unknown>
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('OpenCode plugins must be an array; no changes made.')
  const plugins = (config.plugins ?? []) as unknown[]
  // Same package regardless of version tag or entry form ("x", "x@latest", { package: "x" }).
  const index = plugins.findIndex(plugin => {
    const existing = typeof plugin === 'string' ? plugin : typeof plugin === 'object' && plugin !== null && 'package' in plugin && typeof plugin.package === 'string' ? plugin.package : undefined
    return existing !== undefined && (existing === spec || packageName(existing) === packageName(spec))
  })
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

const PROVIDER_INFO: Record<ProviderID, { name: string; plans: string }> = {
  anthropic: { name: 'Anthropic', plans: 'Claude Pro / Max / Team' },
  openai: { name: 'OpenAI', plans: 'ChatGPT Plus / Pro / Team (Codex)' },
}

/**
 * Word-wraps note text to the terminal so prompt boxes stay intact. Continuation lines keep the
 * indentation of bullets and aligned labels.
 */
export function wrap(text: string, width = Math.max(40, Math.min(80, (process.stdout.columns || 80) - 8))): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length <= width) { out.push(line); continue }
    const lead = /^(\s*(?:[•\-*]\s+|[^:]{1,20}:\s{2,})?)/u.exec(line)?.[1] ?? ''
    const indent = ' '.repeat(Math.min(lead.length, Math.floor(width / 2)))
    let current = lead
    let fresh = true
    for (const word of line.slice(lead.length).split(/\s+/u).filter(Boolean)) {
      if (!fresh && current.length + 1 + word.length > width) {
        out.push(current)
        current = indent + word
      } else current = fresh ? current + word : `${current} ${word}`
      fresh = false
    }
    out.push(current)
  }
  return out.join('\n')
}

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
  if (/(?:^|[\\/])(?:node_modules|_npx|dlx)(?:[\\/]|$)/u.test(root)) return `${PACKAGE_NAME}@latest`
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
    prompts.note(wrap([
      '• Stays on your current account and switches only when it is confirmed out of quota.',
      '• A switch changes the active account for that provider in every OpenCode session.',
      '• Routed providers use HTTP instead of WebSockets so failures can be traced to the right account.',
      '• Usage is checked with Anthropic/OpenAI about every 10 minutes while you are active.',
      '• No credentials are stored. OpenCode keeps managing your sign-ins and token refresh.',
      '• Paid API-key fallback stays off unless you explicitly allow it.',
    ].join('\n')), 'How it works')
    const accounts = await (options.source ?? createCredentialSource()).listAccounts()
    const available = PROVIDERS.filter(provider => accounts.some(account => account.provider === provider && account.method === 'oauth'))
    if (!available.length) { prompts.outro('No subscription accounts found. Connect one in OpenCode with /connect, then run setup again.'); return null }
    const subscriptions = (provider: ProviderID): number => accounts.filter(account => account.provider === provider && account.method === 'oauth').length
    const selected = await ask(prompts.multiselect({
      message: 'Which providers should the router manage?',
      options: available.map(value => ({ value, label: `${PROVIDER_INFO[value].name} — ${PROVIDER_INFO[value].plans}`, hint: `${subscriptions(value)} subscription account${subscriptions(value) === 1 ? '' : 's'}` })),
      required: true,
    }))
    if (!selected.length || selected.some(provider => !available.some(value => value === provider))) throw new Error('Select at least one available provider.')
    const config = defaultConfig()
    for (const provider of PROVIDERS) {
      if (!selected.includes(provider)) continue
      const name = PROVIDER_INFO[provider].name
      const oauth = accounts.filter(account => account.provider === provider && account.method === 'oauth')
      const accountIDs = await ask(prompts.multiselect({ message: `${name}: which subscription accounts should take part?`, options: oauth.map(account => ({ value: account.id, label: cleanLabel(account.label), hint: account.needsAuth ? 'needs sign-in' : account.active ? 'currently active' : undefined })), required: true }))
      if (!accountIDs.length || accountIDs.some(id => !oauth.some(account => account.id === id))) throw new Error('Invalid OAuth account selection.')
      // A generated sentinel cannot collide with a real account ID.
      const automatic = `automatic-${randomUUID()}`
      const favorite = await ask(prompts.select({ message: `${name}: favorite account (used when a fresh choice is needed)`, options: [{ value: automatic, label: 'Automatic', hint: 'running window first, then most weekly allowance left' }, ...oauth.filter(account => accountIDs.includes(account.id)).map(account => ({ value: account.id, label: cleanLabel(account.label) }))] }))
      config.providers[provider] = { accountIDs, accountLabels: Object.fromEntries(oauth.filter(account => accountIDs.includes(account.id)).map(account => [account.id, cleanLabel(account.label) || account.id])), ...(favorite !== automatic ? { favoriteAccountID: favorite } : {}), allowPaidFallback: false, apiKeyModels: [] }
      const keys = accounts.filter(account => account.provider === provider && account.method === 'key')
      if (keys.length && await ask(prompts.confirm({ message: `${name}: use a paid API key as the last fallback?`, initialValue: false }))) {
        const keyID = await ask(prompts.select({ message: `${name}: which API key?`, options: keys.map(account => ({ value: account.id, label: cleanLabel(account.label) })) }))
        if (!keys.some(account => account.id === keyID)) throw new Error('Invalid API-key account selection.')
        const paid = await ask(prompts.confirm({ message: `Allow PAID ${name} API usage once every subscription is exhausted? The switch is provider-global, so other sessions may also bill the key.`, initialValue: false }))
        if (paid) {
          const models = await ask(prompts.text({ message: 'Which models may use the paid key? Exact IDs, comma-separated (no wildcard)', placeholder: provider === 'anthropic' ? 'claude-sonnet-5-5, claude-opus-5-5' : 'gpt-6.1-sol', validate: validateModels }))
          const error = validateModels(models)
          if (error) throw new Error(error)
          config.providers[provider] = { ...config.providers[provider]!, accountLabels: { ...config.providers[provider]!.accountLabels, [keyID]: cleanLabel(keys.find(account => account.id === keyID)!.label) || keyID }, apiKeyAccountID: keyID, allowPaidFallback: true, apiKeyModels: models.split(',').map(value => value.trim()) }
        }
      }
    }
    const minutes = await ask(prompts.text({ message: 'Check usage every how many minutes? (5–60)', defaultValue: '10', placeholder: '10', validate: validateMinutes }))
    if (validateMinutes(minutes)) throw new Error('Polling interval must be between 5 and 60 minutes.')
    config.pollIntervalMs = Number(minutes) * 60_000
    const validated = parseConfig(config)
    const review: string[] = []
    for (const provider of PROVIDERS) {
      const settings = validated.providers[provider]
      if (!settings) continue
      const label = (id: string): string => cleanLabel(settings.accountLabels?.[id] ?? id)
      review.push(`${PROVIDER_INFO[provider].name}`)
      review.push(`  Accounts:       ${settings.accountIDs.map(label).join(', ')}`)
      review.push(`  Favorite:       ${settings.favoriteAccountID ? label(settings.favoriteAccountID) : 'automatic'}`)
      review.push(`  Paid fallback:  ${settings.allowPaidFallback && settings.apiKeyAccountID ? `ON — ${label(settings.apiKeyAccountID)} for ${settings.apiKeyModels.map(cleanLabel).join(', ')}` : 'off'}`)
    }
    review.push(`Usage checks:     every ${Number(minutes)} minutes while active`)
    review.push('Routing:          smart (after 5 quiet minutes, use the allowance that expires first; set "strategy": "sticky" to only switch when one runs out)')
    review.push('Credentials:      none stored')
    prompts.note(wrap(review.join('\n')), 'Review')
    if (!await ask(prompts.confirm({ message: 'Save this configuration?', initialValue: false }))) { prompts.outro('Cancelled; no files changed.'); return null }
    const configPath = options.configPath ?? defaultConfigPath()
    const spec = options.pluginSpec ?? await defaultPluginSpec()
    let installation: { path: string; original: string | null; updated: string } | undefined
    if (spec) {
      if (await ask(prompts.confirm({ message: `Add "${spec}" to your global opencode.json (after your auth plugins)? A private backup is made first.`, initialValue: true }))) {
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
        installation = { path, original, updated: appendPlugin(original ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', spec, resolve(configPath) === resolve(defaultConfigPath()) ? undefined : { configPath: resolve(configPath) }) }
      }
    } else prompts.note(`Plugin not installed automatically. Run via \`npx ${PACKAGE_NAME} setup\`, run from a local checkout, or pass --plugin <package-or-path>.`, 'Plugin installation')
    // All consent and validation complete before the first filesystem write.
    if (installation && installation.updated !== installation.original) {
      if (installation.original !== null) await atomicWriteText(`${installation.path}.backup-${randomUUID()}`, installation.original)
    }
    await saveConfig(validated, configPath)
    if (installation && installation.updated !== installation.original) await atomicWriteText(installation.path, installation.updated)
    prompts.outro(installation ? 'Saved. OpenCode picks this up automatically (run /reload if it was already open). Check it any time with /router-status.' : 'Saved. Run /reload in OpenCode if the router is already loaded, then check it with /router-status.')
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
