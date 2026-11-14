/**
 * Build the browser half of the plugin.
 *
 * The Harness client module system does not serve an ESM module; it serves a
 * lazy-CJS factory that registers itself on `window.__ModuleLoader__` and
 * resolves its externals through the injected `require` (the page's module
 * table). This script produces exactly that artifact from `src/client/`.
 *
 * The module table already owns React and the shared UI packages, so they stay
 * external: bundling a second copy would give the page two React instances and
 * two slot registries. Everything else is inlined.
 *
 * Upstream builds this shape with a workspace-local tsdown preset
 * (`packages/client/tsdown.client.ts`) that is not published, so a package
 * outside the Harness repository reproduces the essential part of it here.
 */

import { readFile } from 'node:fs/promises'
import { build } from 'rolldown'

const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const id = manifest.name

const banner = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(id)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '',
].join('\n')

const footer = ['    return module.exports;', '  },', '});', ''].join('\n')

await build({
  input: new URL('../src/client/index.ts', import.meta.url).pathname,
  platform: 'browser',
  external: (source) => EXTERNALS.has(source),
  resolve: { conditionNames: ['browser', 'import', 'module', 'default'] },
  transform: {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    jsx: { runtime: 'automatic' },
  },
  output: {
    format: 'cjs',
    dir: new URL('../lib', import.meta.url).pathname,
    entryFileNames: 'client.js',
    sourcemap: true,
    banner,
    footer,
    exports: 'named',
  },
})
