import { stripVTControlCharacters } from 'node:util'

export function cleanLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 160)
}
