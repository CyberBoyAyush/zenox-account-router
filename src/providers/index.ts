import type { ProviderAdapter, ProviderID } from '../types.js'
import { anthropicAdapter } from './anthropic.js'
import { openaiAdapter } from './openai.js'

export { anthropicAdapter, openaiAdapter }
export { checkRetryAfter, readBoundedJson } from './shared.js'
export const adapters: Record<ProviderID, ProviderAdapter> = { anthropic: anthropicAdapter, openai: openaiAdapter }
