import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/adapter/agentjail-client.ts', 'src/security/policy.ts'],
  platform: 'node',
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outDir: 'lib',
  // The package is ESM (`"type": "module"`), so emit `.js`/`.d.ts` rather than
  // `.mjs`/`.d.mts` and keep the `exports` map free of extension-specific keys.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/],
  },
})
