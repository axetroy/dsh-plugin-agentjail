// Confirms the built package loads and exposes the plugin surface Cordis needs.
//
// A bundling change can silently drop an export, and the failure only appears
// when a user boots a profile. This check fails the build instead.

import { readFile } from 'node:fs/promises'

const entry = new URL('../lib/index.js', import.meta.url)
const module = await import(entry.href)

const required = ['name', 'inject', 'apply', 'ConfigSchema']
const missing = required.filter((key) => !(key in module))
if (missing.length > 0) {
  console.error(`lib/index.js is missing required exports: ${missing.join(', ')}`)
  process.exit(1)
}

if (typeof module.apply !== 'function') {
  console.error('lib/index.js must export apply as a function')
  process.exit(1)
}

if (module.name !== 'agentjail') {
  console.error(`the plugin must be named "agentjail"; found "${String(module.name)}"`)
  process.exit(1)
}

// The bundle patch references the package by name, so a rename that misses the
// patch would produce a profile that installs and then fails to resolve a row.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
if (!patch.includes(manifest.name)) {
  console.error(`cordis.patch.yml does not reference the package name "${manifest.name}"`)
  process.exit(1)
}
if (!patch.includes(`id: ${module.name}`)) {
  console.error(`cordis.patch.yml does not declare a row with id "${module.name}"`)
  process.exit(1)
}

console.log('package entry point loads and exports the plugin surface')
