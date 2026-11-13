// Confirms the package declares a DSH bundle whose patch file exists.
//
// A package without `dsh.bundle` still installs, but as a plain dependency:
// `dsh plugin` warns and activates no layer. That is a quiet failure at install
// time, so it is checked here instead.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

function fail(message) {
  console.error(message)
  process.exit(1)
}

const patch = manifest.dsh?.bundle?.patch
if (typeof patch !== 'string' || patch.length === 0) {
  fail('package.json must declare dsh.bundle.patch so `dsh plugin add` activates a layer')
}

const patches = Array.isArray(patch) ? patch : [patch]
for (const entry of patches) {
  if (!existsSync(resolve(root, entry))) {
    fail(`dsh.bundle.patch points at a missing file: ${entry}`)
  }
}

if (typeof manifest.engines?.dsh !== 'string') {
  fail('package.json must declare engines.dsh so profile startup can check compatibility')
}

// Every module a patch row references must be an entry point the package ships,
// or a profile resolves the row and then fails to import it.
const entry = manifest.exports?.['.']?.default
if (typeof entry !== 'string' || !existsSync(resolve(root, entry))) {
  fail('package.json must declare an exports["."].default entry point that exists')
}

if (!Array.isArray(manifest.files) || !manifest.files.includes('cordis.patch.yml')) {
  fail('the published files list must include cordis.patch.yml')
}

for (const required of ['policy', 'lib']) {
  if (!Array.isArray(manifest.files) || !manifest.files.includes(required)) {
    fail(`the published files list must include ${required}`)
  }
}

console.log(`bundle manifest is valid; patch=${patches.join(',')}`)
