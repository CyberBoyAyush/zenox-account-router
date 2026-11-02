import type { Segment, Tone } from './report.js'

const CODES: Record<Tone, string> = {
  text: '',
  strong: '1',
  muted: '2',
  faint: '90',
  accent: '1;36',
  good: '32',
  warn: '33',
  bad: '31',
}

/** Follows the NO_COLOR / FORCE_COLOR conventions; otherwise colour only an interactive terminal. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  return stream.isTTY === true && env.TERM !== 'dumb'
}

export function ansiPaint(segment: Segment): string {
  const code = CODES[segment.tone ?? 'text']
  return code && segment.text.trim() ? `\x1b[${code}m${segment.text}\x1b[0m` : segment.text
}
