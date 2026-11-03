export const PROVIDERS = ['anthropic', 'openai'] as const
export type ProviderID = (typeof PROVIDERS)[number]

export interface Account {
  id: string
  provider: ProviderID
  label: string
  method: 'oauth' | 'key'
  active: boolean
  needsAuth?: boolean
}

export interface StoredCredential extends Account {
  access?: string
  key?: string
  expiresAt?: number
  metadata?: Record<string, unknown>
}

export interface UsageWindow {
  id: string
  label: string
  usedPercent: number | null
  resetsAt: number | null
  durationSeconds?: number
  model?: string
}

export interface UsageSnapshot {
  provider: ProviderID
  accountID: string
  checkedAt: number
  status: 'ok' | 'expired' | 'needs-auth' | 'rate-limited' | 'unavailable' | 'unsupported'
  windows: UsageWindow[]
  allowed?: boolean
  plan?: string
  retryAt?: number
}

export interface QuotaEvidence {
  kind: 'quota' | 'transient' | 'auth' | 'model-restriction' | 'unknown'
  scope: 'account' | 'model'
  resetAt?: number
  code?: string
}

export type Fetch = typeof globalThis.fetch

export interface ProviderAdapter {
  id: ProviderID
  readUsage(credential: StoredCredential, options: { now: number; fetch: Fetch; signal?: AbortSignal }): Promise<UsageSnapshot>
  classify(status: number, headers: Headers, body: unknown, now: number): QuotaEvidence
  matchesRequest(credential: StoredCredential, request: Request): boolean
}

export interface ProviderConfig {
  accountIDs: string[]
  accountLabels?: Record<string, string>
  favoriteAccountID?: string
  apiKeyAccountID?: string
  allowPaidFallback: boolean
  apiKeyModels: string[]
}

/**
 * `smart` also moves to the account whose allowance expires soonest, but only at a cache-safe moment.
 * `sticky` only ever switches when the active account runs out.
 */
export type RoutingStrategy = 'smart' | 'sticky'

export interface RouterConfig {
  version: 1
  pollIntervalMs: number
  idleTimeoutMs: number
  strategy: RoutingStrategy
  /**
   * Override for how long a prompt cache stays warm after its last request; smart switches wait this long.
   * Unset: OpenCode's configured `cache.ttl`, else the provider default (Anthropic 5 minutes, OpenAI 30 minutes).
   */
  cacheWindowMs?: number
  providers: Partial<Record<ProviderID, ProviderConfig>>
}

export interface Cooldown {
  until: number
  confirmedAt: number
  model?: string
}

export interface RouterState {
  version: 1
  usage: Record<string, UsageSnapshot>
  cooldowns: Record<string, Cooldown>
  sticky: Partial<Record<ProviderID, string>>
  /** Last conversation request per provider, so a restart or another OpenCode process keeps warm caches. */
  activity?: Partial<Record<ProviderID, number>>
}

export type RouterEvent =
  | 'loaded' | 'load-failed' | 'unloaded' | 'cache' | 'start' | 'pause'
  | 'use' | 'usage' | 'quota' | 'ignored' | 'failover' | 'no-switch'
  | 'switch' | 'keep' | 'wait' | 'reclaim' | 'error'

/** One decision-log entry. Never holds credentials; labels and reasons are human-readable. */
export interface RouterDecision {
  at: number
  provider: ProviderID | 'router'
  event: RouterEvent
  level?: 'info' | 'warn' | 'error'
  from?: string
  to?: string
  reason: string
}

export interface ReadOptions {
  /** Allow the credential owner to refresh expired/expiring tokens. Only failover needs this. */
  refresh?: boolean
}

export interface CredentialSource {
  /** `timeoutMs` bounds (and kills) any OpenCode command the source runs. */
  listAccounts(options?: { timeoutMs?: number }): Promise<Account[]>
  readCredentials(provider: ProviderID, options?: ReadOptions): Promise<StoredCredential[]>
}

export interface RouterHost extends CredentialSource {
  /** Resolves `false` when the host could not confirm the switch fully applied (retry should wait). */
  activate(provider: ProviderID, accountID: string): Promise<boolean | void>
  /** Longest prompt-cache lifetime OpenCode is configured to request for this provider (`cache.ttl`), in ms. */
  cacheTTL?(provider: ProviderID): Promise<number | undefined>
}
