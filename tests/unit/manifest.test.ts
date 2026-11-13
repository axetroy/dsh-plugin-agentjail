import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRYPOINT_FILE, POLICY_TEMPLATES } from '../../src/security/policy.js'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  type: string
  license: string
  files: string[]
  exports: Record<string, { types?: string; default?: string }>
  engines: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
  peerDependencies: Record<string, string>
  dependencies: Record<string, string>
}

describe('package manifest', () => {
  it('declares a DSH bundle whose patch file exists', () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(typeof patch).toBe('string')
    expect(existsSync(resolve(root, patch as string))).toBe(true)
  })

  it('declares the DSH range so profile startup can check compatibility', () => {
    expect(manifest.engines['dsh']).toMatch(/^>=/)
  })

  it('declares a Node range the build toolchain can actually run', () => {
    // tsdown and its rolldown plugin require Node 22.18+, and `prepare` runs the
    // build on install, so the floor cannot be lower than the toolchain's.
    expect(manifest.engines['node']).toMatch(/^>=22\.18/)
  })

  it('ships every artifact a consumer needs', () => {
    const required = [
      'lib',
      'cordis.patch.yml',
      'policy',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE',
      'CHANGELOG.md',
      'docs',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'DESIGN.md',
    ]
    for (const entry of required) {
      expect(manifest.files).toContain(entry)
    }
  })

  it('keeps Harness packages out of dependencies, so instances are shared', () => {
    for (const name of Object.keys(manifest.dependencies)) {
      expect(name.startsWith('@deepseek-ai/dsh')).toBe(false)
      expect(name.startsWith('@deepseek-ai/cordis')).toBe(false)
    }
  })

  it('declares the harness packages the plugin imports as peers', () => {
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
      expect(manifest.peerDependencies[name]).toBeDefined()
    }
  })

  it('exposes an entry point under lib', () => {
    const entry = manifest.exports['.']?.default
    expect(typeof entry).toBe('string')
    expect(entry).toMatch(/^\.\/lib\//)
  })

  it('is an ESM package', () => {
    expect(manifest.type).toBe('module')
  })

  it('is Apache-2.0 licensed, and the LICENSE file agrees', () => {
    expect(manifest.license).toBe('Apache-2.0')
    const license = readFileSync(resolve(root, 'LICENSE'), 'utf8')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0')
  })
})

describe('bundle patch', () => {
  const patch = readFileSync(resolve(root, manifest.dsh?.bundle?.patch as string), 'utf8')

  it('references the package by name, so Node resolution finds it', () => {
    expect(patch).toContain(manifest.name)
  })

  it('declares the row id the plugin exports as its name', () => {
    expect(patch).toContain('id: agentjail')
  })

  it('ships a fail-closed default', () => {
    expect(patch).toContain('failureAction: deny')
    expect(patch).toContain('defaultAction: deny')
    expect(patch).toContain('enforcement: enforce')
  })

  it('never defaults a fallback verdict to allow', () => {
    expect(patch).not.toMatch(/failureAction:\s*allow/)
    expect(patch).not.toMatch(/defaultAction:\s*allow/)
  })

  it('starts with an empty exemption list', () => {
    expect(patch).toContain('exemptTools: []')
    expect(patch).toContain('exemptToolPrefixes: []')
  })
})

describe('checked-in policy bundle', () => {
  const names = readdirSync(resolve(root, 'policy'))

  it('has a rendered module for every shipped template', () => {
    for (const template of POLICY_TEMPLATES) {
      expect(names.some((name) => name.endsWith(`-${template.name}.rego`))).toBe(true)
    }
  })

  it('includes the generated entrypoint', () => {
    expect(names).toContain(ENTRYPOINT_FILE)
  })
})

describe('release workflow', () => {
  const release = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
  // Strip comment lines: the prose explains that no token is used and would
  // otherwise satisfy a substring check for one.
  const effective = release
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  it('publishes with OIDC, so it needs id-token: write', () => {
    expect(effective).toMatch(/id-token:\s*write/)
  })

  it('holds no npm token, because trusted publishing does not need one', () => {
    // A regression here would silently restore a long-lived credential to the
    // release path, which is exactly what trusted publishing removes.
    expect(effective).not.toMatch(/NPM_TOKEN/)
    expect(effective).not.toMatch(/NODE_AUTH_TOKEN/)
    expect(effective).not.toMatch(/secrets\.NPM/)
  })

  it('asserts the npm CLI version trusted publishing requires', () => {
    expect(effective).toContain('11.5.1')
  })

  it('checks the tag matches package.json before publishing', () => {
    expect(effective).toContain('GITHUB_REF_NAME')
    expect(effective).toMatch(/does not match package.json/)
  })
})

describe('codeql workflow', () => {
  const codeql = readFileSync(resolve(root, '.github/workflows/codeql.yml'), 'utf8')

  it('loads the alert-suppression query, without which suppressions are inert', () => {
    // An inline `codeql[...]` comment does nothing unless this query runs, and it
    // is not part of the default suite, so the pack has to be requested by name.
    expect(codeql).toMatch(/packs:\s*codeql\/javascript-queries:AlertSuppression\.ql/)
  })
})
