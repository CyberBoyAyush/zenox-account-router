import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('works in a forced-colour terminal: OpenCode is asked for plain output and the CLI output is coloured', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'router-bin-test-'))
    try {
      await mkdir(join(directory, 'fake-bin'))
      const fixture = [{ id: 'openai', connections: [{ type: 'credential', id: 'synthetic-o', label: 'ChatGPT Pro', method: 'oauth' }] }]
      // Mimics OpenCode styling `--version` when colour is forced and not disabled.
      await writeFile(join(directory, 'fake-bin', 'opencode'), `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconst styled = process.env.FORCE_COLOR && !process.env.NO_COLOR;\nif (args[0] === '--version') console.log(styled ? '\\u001b[1mopencode\\u001b[0m \\u001b[2mv\\u001b[0m\\u001b[1m2.2.5\\u001b[0m' : 'opencode v2.2.5');\nelse if (args[0] === 'auth' && args[1] === 'list') console.log(${JSON.stringify(JSON.stringify(fixture))});\nelse process.exit(3);\n`, { mode: 0o700 })
      const result = await execute(process.execPath, [resolve('dist/cli.js'), 'accounts'], { env: { ...process.env, FORCE_COLOR: '1', PATH: `${join(directory, 'fake-bin')}:${process.env.PATH ?? ''}` }, timeout: 10_000 })
      expect(result.stdout).toContain('\x1b[1;36mOPENAI\x1b[0m')
      expect(result.stdout).toContain('ChatGPT Pro')
      expect(result.stdout).toContain('\x1b[32m  ACTIVE\x1b[0m')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('published terminal UI build', () => {
  it('compiles the themed dialog to plain JS that imports only what OpenCode provides', async () => {
    const view = await readFile(resolve('dist/tui-view.js'), 'utf8')
    const imports = [...view.matchAll(/^import .* from ["'](.+)["'];?$/gmu)].map(match => match[1])
    expect(new Set(imports)).toEqual(new Set(['@opentui/solid', 'solid-js', './report.js']))
    expect(view).not.toMatch(/<box|<text|<span/u)
    await expect(access(resolve('dist/tui-view.jsx'))).rejects.toThrow()
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { exports: Record<string, { import: string }>; dependencies: Record<string, string> }
    expect(manifest.exports['./tui']!.import).toBe('./dist/tui.js')
    // OpenCode's TUI supplies these at runtime; shipping our own copies would split Solid's reactivity.
    expect(Object.keys(manifest.dependencies).filter(name => /solid|opentui/u.test(name))).toEqual([])
    expect(await readFile(resolve('dist/tui.js'), 'utf8')).toContain("import('./tui-view.js')")
  })
})
