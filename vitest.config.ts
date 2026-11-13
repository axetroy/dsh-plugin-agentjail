import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The adapter and integration suites open real Unix sockets, so they need a
    // real event loop and real timers rather than a sandboxed substitute.
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
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
