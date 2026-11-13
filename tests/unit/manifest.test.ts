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

  it('runs changesets, so a version bump and changelog are generated, not typed', () => {
    expect(effective).toMatch(/changesets\/action@v1/)
    expect(effective).toContain('npm run version-packages')
    expect(effective).toContain('npm run release')
  })

  it('lets the action open the version pull request it then merges', () => {
    // Without these the action cannot open the PR that gates a publish.
    expect(effective).toMatch(/pull-requests:\s*write/)
    expect(effective).toMatch(/contents:\s*write/)
  })

  it('tags and publishes through changeset publish, which derives the tag', () => {
    // `changeset publish` reads the version from package.json to build the tag,
    // so a tag/version skew is impossible by construction and the old manual
    // comparison is gone. The publish command is where that now lives.
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['release']).toBe('changeset publish')
    expect(pkg.scripts['version-packages']).toBe('changeset version')
  })
})

describe('changesets configuration', () => {
  const config = JSON.parse(readFileSync(resolve(root, '.changeset/config.json'), 'utf8')) as {
    access: string
    baseBranch: string
    changelog: string | false
  }

  it('publishes a public package', () => {
    expect(config.access).toBe('public')
  })

  it('bases the version pull request on main, the branch the release runs on', () => {
    expect(config.baseBranch).toBe('main')
  })

  it('generates a changelog, since CHANGELOG.md is no longer hand-edited', () => {
    expect(config.changelog).not.toBe(false)
  })
})

describe('coverage gate', () => {
  const vitest = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

  it('fails a pull request that drops coverage below the baseline', () => {
    expect(vitest).toMatch(/thresholds:\s*\{/)
    for (const key of ['statements', 'branches', 'functions', 'lines']) {
      expect(vitest).toMatch(new RegExp(`${key}:\\s*\\d+`))
    }
  })

  it('measures coverage on every CI run, so the gate cannot be skipped', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('npm run test:coverage')
  })
})

describe('vendored build', () => {
  const lock = JSON.parse(readFileSync(resolve(root, 'vendor.lock.json'), 'utf8')) as {
    version: string
    releaseBaseUrl: string
    supportedWindow: { min: string; maxMajor: number }
    targets: Record<string, { asset: string; sha256: string }>
  }

  it('ships the vendor directory in the published package', () => {
    expect(manifest.files).toContain('vendor')
  })

  it('pins a version and a full-length checksum for every platform it ships', () => {
    expect(lock.version).toMatch(/^v\d+\.\d+\.\d+$/)
    const targets = Object.keys(lock.targets)
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      const entry = lock.targets[target]
      // A short or placeholder digest would make the release-time check a no-op.
      expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry?.asset).toContain(lock.version)
    }
  })

  it('covers the platforms the plugin claims to support', () => {
    for (const target of ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']) {
      expect(Object.keys(lock.targets)).toContain(target)
    }
  })

  it('pins the supported window the plugin gates on', () => {
    expect(lock.supportedWindow.min).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.supportedWindow.maxMajor).toBeGreaterThan(0)
  })

  it('keeps the vendored build out of version control', () => {
    // A 41 MB binary per platform does not belong in git. It is fetched and
    // verified at release time instead.
    const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^vendor\/$/m)
  })

  it('vendors every binary the upstream CLI needs, not just the daemon', () => {
    // Upstream ships `agentjail-hook` alongside `agentjail`, and the CLI's own
    // `install` command aborts without it next to the daemon binary. Copying
    // only `agentjail` produces a package whose CLI cannot install hooks.
    const script = readFileSync(resolve(root, 'scripts/vendor-agentjail.mjs'), 'utf8')
    const hook = script.indexOf("'agentjail-hook'")
    expect(hook).toBeGreaterThan(-1)
    // Both must be chmod'ed; a copied-but-not-executable hook is still broken.
    const executables = script.match(/const EXECUTABLE_FILES = \[([^\]]*)\]/)
    expect(executables?.[1]).toContain("'agentjail'")
    expect(executables?.[1]).toContain("'agentjail-hook'")
  })

  it('fails the vendored check when either binary is absent', () => {
    // `checkTarget` iterates the executable list, so a vendor directory that
    // lost one binary cannot pass `vendor:check` and reach a release.
    const script = readFileSync(resolve(root, 'scripts/vendor-agentjail.mjs'), 'utf8')
    const check = script.slice(script.indexOf('async function checkTarget'))
    expect(check).toContain('for (const name of EXECUTABLE_FILES)')
  })

  it('requires both binaries to ship in the packed tarball', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain("for (const name of ['agentjail', 'agentjail-hook'])")
  })

  it('verifies the archive before unpacking it, so a mismatch never runs', () => {
    const script = readFileSync(resolve(root, 'scripts/vendor-agentjail.mjs'), 'utf8')
    // The checksum comparison must precede the extraction call, or a tampered
    // download could reach the filesystem as a runnable file. The function
    // definition is skipped, so this compares the two call sites.
    const digest = script.indexOf('sha256File(archive)')
    const compare = script.indexOf('checksum mismatch')
    const extract = script.indexOf('extractArchive(archive, unpacked)')
    expect(digest).toBeGreaterThan(-1)
    expect(extract).toBeGreaterThan(-1)
    expect(digest).toBeLessThan(extract)
    expect(compare).toBeLessThan(extract)
  })

  it('vendors at release time so a published package is self-contained', () => {
    const release = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    expect(release).toContain('npm run vendor:all')
  })

  it('exercises the real binary in CI, not just a stand-in', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('AGENTJAIL_E2E=1')
    expect(ci).toContain('npm run vendor')
  })
})

describe('codeql workflow', () => {
  const codeql = readFileSync(resolve(root, '.github/workflows/codeql.yml'), 'utf8')

  it('loads the alert-suppression query, without which suppressions are inert', () => {
    // The query is not in the default suite, so the pack has to be named. With
    // it absent, the inline suppression in the installer is not even parsed.
    expect(codeql).toMatch(/packs:\s*codeql\/javascript-queries:AlertSuppression\.ql/)
  })

  it('dismisses suppressed alerts, because code scanning ignores suppressions', () => {
    // GitHub code scanning does not act on the SARIF `suppressions` property, so
    // the pack above only makes the suppression visible. This step is what turns
    // it into a closed alert; drop it and the installer alert reopens.
    expect(codeql).toMatch(/advanced-security\/dismiss-alerts@[0-9a-f]{40}/)
  })

  it('keeps the SARIF the dismiss step reads in a directory analyze writes', () => {
    expect(codeql).toMatch(/output:\s*sarif-results/)
    expect(codeql).toMatch(/sarif-file:\s*sarif-results/)
  })
})
