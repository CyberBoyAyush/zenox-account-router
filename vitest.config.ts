import { defineConfig } from 'vitest/config'

// The embedded OpenCode engine used by tests/e2e needs Node 24+ syntax; the package itself supports Node 22.
const engineSupported = Number(process.versions.node.split('.')[0]) >= 24

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: engineSupported ? [] : ['tests/e2e/**'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/cli.ts'] },
  },
})
