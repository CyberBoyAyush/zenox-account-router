import type { Account } from './types.js'
import { stripVTControlCharacters } from 'node:util'

export function cleanLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 160)
}

export function displayAccounts(accounts: Account[]): string {
  if (!accounts.length) return 'No Anthropic or OpenAI accounts found. Sign in with OpenCode first.'
  return accounts.map(account => `${account.provider}  ${cleanLabel(account.id)}  ${cleanLabel(account.label)}  ${account.method}${account.active ? ' (active)' : ''}${account.needsAuth ? ' (needs sign-in)' : ''}`).join('\n')
}
