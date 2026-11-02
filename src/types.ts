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

export interface RouterConfig {
  version: 1
  pollIntervalMs: number
  idleTimeoutMs: number
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
}

export interface ReadOptions {
  /** Allow the credential owner to refresh expired/expiring tokens. Only failover needs this. */
  refresh?: boolean
}

export interface CredentialSource {
  listAccounts(): Promise<Account[]>
  readCredentials(provider: ProviderID, options?: ReadOptions): Promise<StoredCredential[]>
}

export interface RouterHost extends CredentialSource {
  /** Resolves `false` when the host could not confirm the switch fully applied (retry should wait). */
  activate(provider: ProviderID, accountID: string): Promise<boolean | void>
}
