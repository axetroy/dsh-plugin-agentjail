import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // The real primitives package ships CSS modules and workspace-path helpers
      // that only resolve inside the Harness module table, so importing it under
      // Node fails before any test runs. The stand-in renders the same DOM shape
      // while every line under test stays real; `tsc` still checks the real
      // declarations, so a props change cannot slip through.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/helpers/ui-primitives.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The adapter and integration suites open real Unix sockets, so they need a
    // real event loop and real timers rather than a sandboxed substitute.
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts', 'src/client/index.ts'],
      // A floor, not a target. It fails a pull request that drops coverage
      // rather than one that merely sits below an aspirational number. Measured
      // values sit a point or two above, so ordinary churn does not trip it.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
