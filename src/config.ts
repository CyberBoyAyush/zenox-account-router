import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouterConfig, RouterState } from './types.js'

const id = z.string().trim().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value))
const uniqueIDs = z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length)
const providerSchema = z.object({
  accountIDs: uniqueIDs,
  accountLabels: z.record(id, z.string().min(1).max(160).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))).optional(),
  favoriteAccountID: id.optional(),
  apiKeyAccountID: id.optional(),
  allowPaidFallback: z.boolean().default(false),
  apiKeyModels: z.array(id.refine(value => !/[\s*]/u.test(value))).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.favoriteAccountID && !value.accountIDs.includes(value.favoriteAccountID)) ctx.addIssue({ code: 'custom', message: 'Favorite must be selected' })
  if (value.apiKeyAccountID && value.accountIDs.includes(value.apiKeyAccountID)) ctx.addIssue({ code: 'custom', message: 'Key cannot be an OAuth account' })
  if (value.allowPaidFallback && (!value.apiKeyAccountID || value.apiKeyModels.length === 0)) ctx.addIssue({ code: 'custom', message: 'Paid fallback requires a key and model allowlist' })
  if (new Set(value.apiKeyModels).size !== value.apiKeyModels.length) ctx.addIssue({ code: 'custom', message: 'Duplicate models' })
  if (value.accountLabels && Object.keys(value.accountLabels).some(key => !value.accountIDs.includes(key) && key !== value.apiKeyAccountID)) ctx.addIssue({ code: 'custom', message: 'Labels must belong to selected accounts' })
})

const configSchema = z.object({
  version: z.literal(1),
  pollIntervalMs: z.number().int().min(300_000).max(3_600_000).default(600_000),
  idleTimeoutMs: z.number().int().min(60_000).max(86_400_000).default(600_000),
  strategy: z.enum(['smart', 'sticky']).default('smart'),
  cacheWindowMs: z.number().int().min(60_000).max(86_400_000).optional(),
  providers: z.object({ anthropic: providerSchema.optional(), openai: providerSchema.optional() }).strict(),
}).strict()

const timestamp = z.number().finite().nonnegative().max(8_640_000_000_000_000)
const stateKey = z.string().min(1).max(1024).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value))
const windowSchema = z.object({
  id, label: id, usedPercent: z.number().finite().min(0).max(100).nullable(),
  resetsAt: timestamp.nullable(), durationSeconds: timestamp.optional(), model: id.optional(),
})
const usageSchema = z.object({
  provider: z.enum(['anthropic', 'openai']), accountID: id, checkedAt: timestamp,
  status: z.enum(['ok', 'expired', 'needs-auth', 'rate-limited', 'unavailable', 'unsupported']),
  windows: z.array(windowSchema).max(100), allowed: z.boolean().optional(), plan: id.optional(), retryAt: timestamp.optional(),
})
const stateSchema = z.object({
  version: z.literal(1), usage: z.record(stateKey, usageSchema),
  cooldowns: z.record(stateKey, z.object({ until: timestamp, confirmedAt: timestamp, model: id.optional() })),
  sticky: z.object({ anthropic: id.optional(), openai: id.optional() }),
  activity: z.object({ anthropic: timestamp.optional(), openai: timestamp.optional() }).optional(),
})

export function defaultConfig(): RouterConfig {
  return { version: 1, pollIntervalMs: 600_000, idleTimeoutMs: 600_000, strategy: 'smart', providers: {} }
}

export function defaultConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'account-router.json')
}

export function defaultStatePath(configPath = defaultConfigPath()): string {
  const name = basename(configPath).replace(/\.jsonc?$/u, '')
  return join(dirname(configPath), `${name}.state.json`)
}

export function defaultLogPath(configPath = defaultConfigPath()): string {
  const name = basename(configPath).replace(/\.jsonc?$/u, '')
  return join(dirname(configPath), `${name}.log`)
}

export function parseConfig(input: unknown): RouterConfig {
  const result = configSchema.safeParse(input)
  if (!result.success) throw new Error('Invalid account-router configuration; check provider selections and interval bounds.')
  return result.data
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Refuse symbolic links, including parent directories, before reading or writing. */
export async function assertSafePath(path: string, createDirectories = false): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    const last = index === parts.length - 1
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && !stat.isFile())) throw new Error('Unsafe configuration path.')
    } catch (error) {
      if (!missing(error)) throw new Error('Unsafe configuration path.')
      if (!last && createDirectories) {
        try { await mkdir(current, { mode: 0o700 }) } catch (failure) {
          if (!(failure instanceof Error && 'code' in failure && failure.code === 'EEXIST')) throw new Error('Cannot create configuration directory.')
        }
        const stat = await lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe configuration path.')
      }
    }
  }
}

export async function readSafeText(path: string): Promise<string | null> {
  await assertSafePath(path)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid configuration file.')
    return await handle.readFile('utf8')
  } catch (error) {
    if (missing(error)) return null
    throw new Error('Cannot read configuration file safely.')
  } finally { await handle?.close() }
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  await assertSafePath(path, true)
  const temporary = join(dirname(resolve(path)), `.${basename(path)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await assertSafePath(path)
    await rename(temporary, path)
  } catch {
    throw new Error('Cannot write configuration file safely.')
  } finally {
    await handle?.close()
    await unlink(temporary).catch(() => undefined)
  }
}

export async function loadConfig(path = defaultConfigPath()): Promise<RouterConfig | null> {
  const text = await readSafeText(path)
  if (text === null) return null
  try { return parseConfig(JSON.parse(text) as unknown) } catch { throw new Error('Invalid account-router configuration.') }
}

export async function saveConfig(config: RouterConfig, path = defaultConfigPath()): Promise<void> {
  const { strategy, ...rest } = parseConfig(config)
  // The default strategy is left out so older plugin versions (strict schema) can still read the file.
  const data = { ...rest, ...(strategy !== 'smart' ? { strategy } : {}) }
  await atomicWriteText(path, `${JSON.stringify(data, null, 2)}\n`)
}

export function emptyState(): RouterState {
  return { version: 1, usage: {}, cooldowns: {}, sticky: {} }
}

export async function readState(path: string): Promise<RouterState> {
  const text = await readSafeText(path)
  if (text === null) return emptyState()
  try { return stateSchema.parse(JSON.parse(text) as unknown) } catch { throw new Error('Invalid account-router state.') }
}

export async function saveState(state: RouterState, path: string): Promise<void> {
  if (basename(path) === 'account-router.json') throw new Error('State path cannot overwrite router configuration.')
  const existing = await readSafeText(path)
  let previous: RouterState | undefined
  if (existing !== null) {
    let input: unknown
    try { input = JSON.parse(existing) as unknown } catch { throw new Error('Refusing to overwrite an unrecognized state file.') }
    const parsed = stateSchema.safeParse(input)
    if (!parsed.success) throw new Error('Refusing to overwrite a non-state file.')
    previous = parsed.data
  }
  const result = stateSchema.safeParse(state)
  if (!result.success) throw new Error('Invalid account-router state.')
  // Several OpenCode processes share this file; activity only ever moves forward so none hides another's warm cache.
  const activity = { ...previous?.activity }
  for (const [provider, at] of Object.entries(result.data.activity ?? {}) as [keyof typeof activity, number | undefined][]) {
    if (at !== undefined) activity[provider] = Math.max(activity[provider] ?? 0, at)
  }
  const data = Object.keys(activity).length ? { ...result.data, activity } : result.data
  await atomicWriteText(path, `${JSON.stringify(data, null, 2)}\n`)
}

export async function readActivity(path: string): Promise<RouterState['activity']> {
  try { return (await readState(path)).activity } catch { return undefined }
}

export const LOG_LIMIT_BYTES = 1024 * 1024

/** Appends one line to the decision log (owner-only). Past 1 MB the file moves to `<name>.1` and a new one starts. */
export async function appendLog(path: string, line: string): Promise<void> {
  await assertSafePath(path, true)
  let handle
  let size = 0
  let inode = 0
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    const stat = await handle.stat()
    // Never write into a file someone else owns, and tighten a log that was made readable by others.
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe log path.')
    if (stat.mode & 0o077) await handle.chmod(0o600)
    await handle.appendFile(`${line.replace(/[\r\n]+/gu, ' ')}\n`, 'utf8')
    const after = await handle.stat()
    size = after.size
    inode = after.ino
  } catch {
    throw new Error('Cannot write router log safely.')
  } finally { await handle?.close() }
  if (size <= LOG_LIMIT_BYTES) return
  await rotateLog(path, inode)
}

/**
 * Moves a full log to `<name>.1`. A lock file (created exclusively) keeps two OpenCode processes from
 * rotating at once, and the inode check makes sure the file being moved is the one that grew too large.
 */
async function rotateLog(path: string, inode: number): Promise<void> {
  const lock = `${path}.lock`
  await assertSafePath(lock)
  let held
  try {
    held = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    // Someone else is rotating; a lock left behind by a crash is cleared after a minute.
    try { if (Date.now() - (await lstat(lock)).mtimeMs > 60_000) await unlink(lock) } catch { /* Next append retries. */ }
    return
  }
  try {
    await assertSafePath(path)
    const current = await lstat(path)
    if (!current.isFile() || current.ino !== inode || current.size <= LOG_LIMIT_BYTES) return
    const previous = `${path}.1`
    await assertSafePath(previous)
    await rename(path, previous)
  } finally {
    await held.close()
    await unlink(lock).catch(() => undefined)
  }
}

/** The newest `count` lines of the decision log, reading into the rotated file when needed. */
export async function readLogTail(path: string, count: number): Promise<string[] | null> {
  const read = async (file: string): Promise<string[] | null> => {
    await assertSafePath(file)
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) return null
      const length = Math.min(stat.size, 2 * LOG_LIMIT_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, stat.size - length)
      return buffer.toString('utf8').split('\n').filter(Boolean)
    } catch (error) {
      if (missing(error)) return null
      throw new Error('Cannot read router log safely.')
    } finally { await handle?.close() }
  }
  const current = await read(path)
  if (current === null) return null
  if (current.length >= count) return current.slice(-count)
  const older = await read(`${path}.1`) ?? []
  return [...older, ...current].slice(-count)
}
