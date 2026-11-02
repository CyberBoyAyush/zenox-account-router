// Compiles src/*.tsx to dist/*.js with Solid's universal JSX transform for OpenTUI, then removes the
// .jsx files tsc emits with `jsx: preserve`. OpenCode supplies @opentui/solid and solid-js at runtime.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import babel from '@babel/core'
import typescript from '@babel/preset-typescript'
import solid from 'babel-preset-solid'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const name of (await readdir(join(root, 'src'))).filter(file => file.endsWith('.tsx'))) {
  const filename = join(root, 'src', name)
  const result = await babel.transformAsync(await readFile(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    presets: [[solid, { moduleName: '@opentui/solid', generate: 'universal' }], [typescript]],
  })
  if (!result?.code) throw new Error(`Empty TUI build output for ${name}`)
  const stem = join(root, 'dist', name.replace(/\.tsx$/, ''))
  await writeFile(`${stem}.js`, `${result.code}\n`)
  await rm(`${stem}.jsx`, { force: true })
  await rm(`${stem}.jsx.map`, { force: true })
}
