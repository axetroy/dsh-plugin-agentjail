/**
 * Version identity and compatibility tests.
 *
 * The parse cases use the real `agentjail version` banner, ANSI escapes and all,
 * because that is the input the plugin actually receives; a tidy `1.8.2` would
 * test a string the binary never prints.
 * @module tests/unit/version
 */

import { describe, expect, it } from 'vitest'
import {
  classifyVersion,
  compareVersions,
  describeCompatibility,
  isVersionSupported,
  parseVersion,
  SUPPORTED_VERSION_WINDOW,
  type AgentJailVersion,
} from '../../src/adapter/version.js'

/** The styled banner upstream prints for `agentjail --no-color version`. */
const BANNER = `
  █ █ █  AgentJail
  █ █ █  policy guardrails for agents
  █ █ █  v1.8.2 · linux

`

describe('parseVersion', () => {
  it('reads the version out of the real version banner', () => {
    expect(parseVersion(BANNER)).toEqual({ major: 1, minor: 8, patch: 2, raw: 'v1.8.2' })
  })

  it('reads a bare version', () => {
    expect(parseVersion('1.8.2')).toEqual({ major: 1, minor: 8, patch: 2, raw: '1.8.2' })
  })

  it('ignores a pre-release suffix for ordering', () => {
    expect(parseVersion('v2.0.0-rc.1')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      raw: 'v2.0.0-rc.1',
    })
  })

  it('ignores build metadata', () => {
    expect(parseVersion('v1.8.2+build.7')).toEqual({
      major: 1,
      minor: 8,
      patch: 2,
      raw: 'v1.8.2+build.7',
    })
  })

  it('does not match digits embedded in a larger number', () => {
    // `11.8.2` must not be read as `1.8.2` by starting mid-number.
    expect(parseVersion('build 11.8.2')?.major).toBe(11)
  })

  it('returns undefined when no version is present', () => {
    expect(parseVersion('agentjail dev')).toBeUndefined()
    expect(parseVersion('')).toBeUndefined()
  })

  it('reads the version from ANSI-styled output', () => {
    expect(parseVersion('\u001b[1mv1.9.0\u001b[0m · linux')?.minor).toBe(9)
  })
})

describe('compareVersions', () => {
  const version = (major: number, minor: number, patch: number): AgentJailVersion => ({
    major,
    minor,
    patch,
    raw: `${major}.${minor}.${patch}`,
  })

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(version(1, 8, 2), version(1, 8, 2))).toBe(0)
    expect(compareVersions(version(1, 8, 2), version(1, 8, 3))).toBeLessThan(0)
    expect(compareVersions(version(1, 9, 0), version(1, 8, 9))).toBeGreaterThan(0)
    expect(compareVersions(version(2, 0, 0), version(1, 99, 99))).toBeGreaterThan(0)
  })
})

describe('classifyVersion', () => {
  it('accepts the window floor and everything up to the next major', () => {
    expect(classifyVersion(parseVersion('v1.8.0'))).toBe('ok')
    expect(classifyVersion(parseVersion('v1.8.2'))).toBe('ok')
    expect(classifyVersion(parseVersion('v1.99.0'))).toBe('ok')
  })

  it('rejects a version below the window', () => {
    expect(classifyVersion(parseVersion('v1.7.9'))).toBe('too-old')
    expect(classifyVersion(parseVersion('v1.0.0'))).toBe('too-old')
    expect(classifyVersion(parseVersion('v0.9.0'))).toBe('too-old')
  })

  it('rejects the next major, which is where the contract may be retired', () => {
    expect(classifyVersion(parseVersion('v2.0.0'))).toBe('too-new')
    expect(classifyVersion(parseVersion('v3.1.0'))).toBe('too-new')
  })

  it('treats an unreadable version as unknown, never as supported', () => {
    expect(classifyVersion(undefined)).toBe('unknown')
    expect(isVersionSupported(undefined)).toBe(false)
  })

  it('honours an injected window', () => {
    const window = { min: '2.0.0', maxMajor: 3 }
    expect(classifyVersion(parseVersion('v1.8.2'), window)).toBe('too-old')
    expect(classifyVersion(parseVersion('v2.4.0'), window)).toBe('ok')
    expect(classifyVersion(parseVersion('v3.0.0'), window)).toBe('too-new')
  })

  it('supports the versions the plugin is documented against', () => {
    expect(isVersionSupported(parseVersion('v1.8.2'))).toBe(true)
  })
})

describe('describeCompatibility', () => {
  it('names the supported window in every description', () => {
    const window = SUPPORTED_VERSION_WINDOW
    const supported = `>=${window.min} <${window.maxMajor}.0.0`
    for (const outcome of ['ok', 'too-old', 'too-new'] as const) {
      expect(describeCompatibility(outcome)).toContain(supported)
    }
  })

  it('says plainly when no version was read', () => {
    expect(describeCompatibility('unknown')).toBe('no version could be read')
  })
})
