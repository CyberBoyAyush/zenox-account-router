import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)

beforeAll(async () => {
  await execute('pnpm', ['build'], { cwd: resolve('.'), timeout: 30_000 })
}, 40_000)

describe('real compiled CLI through an npm-style bin symlink', () => {
  it('prints help and reads only account metadata through the symlink', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'router-bin-test-'))
    try {
      const bin = join(directory, 'zenox-account-router')
      await symlink(resolve('dist/cli.js'), bin)
      const help = await execute(process.execPath, [bin, '--help'], { timeout: 10_000 })
      expect(help.stdout).toContain('zenox-account-router <setup|accounts|status|dry-run>')
      await mkdir(join(directory, 'fake-bin'))
      const fixture = [{ id: 'anthropic', connections: [{ type: 'credential', id: 'synthetic-a', label: 'Synthetic account', method: 'oauth' }] }]
      await writeFile(join(directory, 'fake-bin', 'opencode'), `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('opencode v2.2.5');\nelse if (args[0] === 'auth' && args[1] === 'list') console.log(${JSON.stringify(JSON.stringify(fixture))});\nelse process.exit(3);\n`, { mode: 0o700 })
      const accounts = await execute(process.execPath, [bin, 'accounts', '--json'], { env: { ...process.env, PATH: `${join(directory, 'fake-bin')}:${process.env.PATH ?? ''}` }, timeout: 10_000 })
      expect(JSON.parse(accounts.stdout)).toEqual([{ id: 'synthetic-a', provider: 'anthropic', label: 'Synthetic account', method: 'oauth', active: true, needsAuth: false }])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
