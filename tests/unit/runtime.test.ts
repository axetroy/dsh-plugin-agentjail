/**
 * Runtime layout tests.
 *
 * These assert the properties the isolation actually depends on: that the socket
 * the daemon is told to bind is the socket the plugin connects to, that the
 * private `HOME` moves every derived path. They use real files, because the
 * thing under test is filesystem behavior.
 * @module tests/unit/runtime
 */

import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveName } from '../../src/adapter/installer.js'
import {
  currentPackageRoot,
  daemonArguments,
  daemonEnvironment,
  DAEMON_EXECUTABLE,
  defaultStateDir,
  findPackageRoot,
  isExecutableFile,
  platformLabel,
  resolveRuntimePaths,
  SUPPORTED_PLATFORM_NAMES,
  unsupportedPlatformReason,
  vendoredBinaryPath,
  vendoredDirectory,
} from '../../src/adapter/runtime.js'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentjail-runtime-'))
}

/** Write an executable stand-in for the daemon binary. */
async function fakeBinary(path: string, mode = 0o755): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, mode)
  return path
}

describe('platformLabel', () => {
  it('maps Node names onto upstream release names', () => {
    expect(platformLabel('linux', 'x64')).toEqual({ platform: 'linux', arch: 'amd64' })
    expect(platformLabel('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
  })

  it('reports no build for an unsupported platform or architecture', () => {
    expect(platformLabel('win32', 'x64')).toBeUndefined()
    expect(platformLabel('linux', 'ia32')).toBeUndefined()
  })

  it('agrees with the managed installer on which platforms have a build', () => {
    // The runtime and the installer each carry the platform set, and a
    // divergence would mean one of them claims a build the other cannot name.
    // Every supported platform must produce an archive name, and every
    // unsupported one must not.
    for (const platform of [...SUPPORTED_PLATFORM_NAMES, 'win32', 'freebsd']) {
      for (const arch of ['x64', 'arm64', 'ia32']) {
        const labeled = platformLabel(platform, arch) !== undefined
        expect(archiveName({ platform, arch }, 'v1.8.2') !== undefined).toBe(labeled)
      }
    }
  })
})

describe('unsupportedPlatformReason', () => {
  it('says nothing when the platform has a vendored build', () => {
    for (const platform of SUPPORTED_PLATFORM_NAMES) {
      expect(unsupportedPlatformReason(platform, 'x64')).toBeUndefined()
      expect(unsupportedPlatformReason(platform, 'arm64')).toBeUndefined()
    }
  })

  it('names the platform and the supported set when the platform is unknown', () => {
    const reason = unsupportedPlatformReason('win32', 'x64')
    expect(reason).toContain('win32')
    expect(reason).toContain('linux')
    expect(reason).toContain('darwin')
    expect(reason).toContain('denied')
  })

  it('names the architecture when only the architecture is unknown', () => {
    const reason = unsupportedPlatformReason('linux', 'ia32')
    expect(reason).toContain('ia32')
    expect(reason).toContain('x64')
    expect(reason).toContain('arm64')
    expect(reason).toContain('denied')
  })

  it('tells the operator the plugin will still load, so a denial is not a crash', () => {
    expect(unsupportedPlatformReason('freebsd', 'x64')).toContain('load')
  })
})

describe('resolveRuntimePaths', () => {
  it('keeps every path under the state directory', () => {
    const paths = resolveRuntimePaths('/state/root')
    for (const path of [
      paths.home,
      paths.run,
      paths.policy,
      paths.bin,
      paths.socketPath,
      paths.databasePath,
      paths.logPath,
      paths.policyPath,
      paths.controlSocketPath,
      paths.controlTokenPath,
    ]) {
      expect(path.startsWith('/state/root')).toBe(true)
    }
  })

  it('places the control plane under the private HOME, not the state root', () => {
    // Upstream derives its state root from HOME, so the control socket and token
    // must follow the private HOME. Asserting the exact shape keeps the isolation
    // property from silently regressing if the layout is edited.
    const paths = resolveRuntimePaths('/state/root')
    expect(paths.controlSocketPath).toBe('/state/root/home/.agentjail/run/daemon-ctl.sock')
    expect(paths.controlTokenPath).toBe('/state/root/home/.agentjail/control.token')
  })

  it('falls back to the per-user default for an empty state directory', () => {
    const paths = resolveRuntimePaths('', { HOME: '/home/tester' })
    expect(paths.root).toBe(join('/home/tester', '.agentjail', 'dsh-plugin-agentjail'))
  })

  it('names the default state directory from HOME', () => {
    expect(defaultStateDir({ HOME: '/home/tester' })).toBe(
      '/home/tester/.agentjail/dsh-plugin-agentjail',
    )
  })
})

describe('daemonArguments', () => {
  it('passes the socket, database, and log as explicit flags', () => {
    // Upstream's daemon does not read AGENTJAIL_SOCKET, so the socket must be a
    // flag. Without this the daemon binds its own default and the plugin never
    // reaches the daemon it started.
    const paths = resolveRuntimePaths('/state/root')
    expect(daemonArguments(paths)).toEqual([
      'daemon',
      '--socket',
      paths.socketPath,
      '--db',
      paths.databasePath,
      '--log',
      paths.logPath,
    ])
  })

  it('appends extra arguments after the paths', () => {
    const paths = resolveRuntimePaths('/state/root')
    expect(daemonArguments(paths, 'daemon', ['--verbose']).at(-1)).toBe('--verbose')
  })
})

describe('daemonEnvironment', () => {
  it('gives the daemon a private HOME and its own socket', () => {
    const paths = resolveRuntimePaths('/state/root')
    const env = daemonEnvironment(paths, { HOME: '/home/tester', PATH: '/usr/bin' })
    expect(env['HOME']).toBe(paths.home)
    expect(env['AGENTJAIL_SOCKET']).toBe(paths.socketPath)
    // Unrelated environment is inherited, so the daemon keeps the operator's PATH.
    expect(env['PATH']).toBe('/usr/bin')
  })

  it('disables the update check and telemetry', () => {
    const env = daemonEnvironment(resolveRuntimePaths('/state/root'))
    // A pinned build must not replace itself, and a security plugin should not
    // emit usage data on the operator's behalf.
    expect(env['AGENTJAIL_NO_UPDATE_CHECK']).toBe('1')
    expect(env['AGENTJAIL_SEND_ANONYMOUS_USAGE_STATS']).toBe('0')
  })
})

describe('isExecutableFile', () => {
  it('accepts an executable file and rejects a directory or a missing path', async () => {
    const dir = await scratch()
    const binary = await fakeBinary(join(dir, DAEMON_EXECUTABLE))
    expect(isExecutableFile(binary)).toBe(true)
    expect(isExecutableFile(dir)).toBe(false)
    expect(isExecutableFile(join(dir, 'absent'))).toBe(false)
  })

  it('rejects a file without its executable bit', async () => {
    const dir = await scratch()
    const binary = await fakeBinary(join(dir, DAEMON_EXECUTABLE), 0o644)
    expect(isExecutableFile(binary)).toBe(false)
  })
})

describe('vendored binary lookup', () => {
  it('finds an executable vendored build', async () => {
    const dir = await scratch()
    const path = join(dir, 'vendor', 'linux-amd64', DAEMON_EXECUTABLE)
    await fakeBinary(path)
    expect(vendoredBinaryPath(dir, 'linux', 'x64')).toBe(path)
  })

  it('ignores a vendored build without its executable bit', async () => {
    const dir = await scratch()
    await fakeBinary(join(dir, 'vendor', 'linux-amd64', DAEMON_EXECUTABLE), 0o644)
    expect(vendoredBinaryPath(dir, 'linux', 'x64')).toBeUndefined()
  })

  it('reports no vendored build for an unsupported platform', () => {
    expect(vendoredBinaryPath('/root', 'win32', 'x64')).toBeUndefined()
  })

  it('names the directory a build would live in', () => {
    expect(vendoredDirectory('/root', 'darwin', 'arm64')).toBe('/root/vendor/darwin-arm64')
  })
})

describe('package root discovery', () => {
  it('finds the plugin package root from a nested directory', () => {
    const root = findPackageRoot(join(process.cwd(), 'src', 'adapter'))
    expect(root).toBe(process.cwd())
  })

  it('stops at the filesystem root when no manifest matches', () => {
    expect(findPackageRoot('/')).toBeUndefined()
  })

  it('resolves the package root from the module location', () => {
    expect(currentPackageRoot()).toBe(process.cwd())
  })
})
