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

// The browser half is a separate artifact with its own failure mode: the client
// module system loads it by URL and reads `window.__ModuleLoader__`, so a bundle
// that lost its banner, its id, or its settings registration would load and then
// contribute nothing — a section that silently never appears. These assertions
// run against the built file rather than the source.
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
for (const [needle, why] of [
  ['window.__ModuleLoader__.load(', 'registers itself with the client module system'],
  [`id: ${JSON.stringify(manifest.name)}`, 'is identified by the package name'],
  ['settings.section', 'contributes the AgentJail settings section'],
  ['factory: (require)', 'exports the lazy-CJS factory the loader calls'],
]) {
  if (!client.includes(needle)) {
    console.error(`lib/client.js does not contain ${JSON.stringify(needle)}: it must ${why}`)
    process.exit(1)
  }
}

// Bundling a second React copy would give the page two instances and two slot
// registries, so the shared packages have to stay external.
for (const shared of ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
  if (!client.includes(`require(${JSON.stringify(shared)})`)) {
    console.error(
      `lib/client.js must resolve "${shared}" from the page module table, not inline it`,
    )
    process.exit(1)
  }
}

console.log('package entry point loads and exports the plugin surface')
