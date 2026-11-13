import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAEMON_BINARY_NAME,
  DaemonSupervisor,
  defaultManagedDir,
  findOnPath,
  hasManagedBinary,
  isExecutable,
  resolveDaemonBinary,
  type BinaryVersionCheck,
  type SupervisorOptions,
} from '../../src/adapter/supervisor.js'
import { classifyVersion, parseVersion } from '../../src/adapter/version.js'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentjail-sup-'))
}

async function fakeBinary(directory: string, name = DAEMON_BINARY_NAME): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
  return path
}

function options(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    enabled: true,
    binary: '',
    socketPath: '/tmp/does-not-matter.sock',
    managedDir: '/nonexistent-managed-dir',
    vendoredDir: '/nonexistent-vendored-dir',
    stateDir: '/tmp/agentjail-supervisor-test-state',
    args: ['daemon'],
    startTimeoutMs: 200,
    pollIntervalMs: 10,
    requireSupportedVersion: false,
    ...overrides,
  }
}

describe('binary discovery', () => {
  it('accepts an executable file and rejects a directory', async () => {
    const dir = await scratch()
    const path = await fakeBinary(dir)
    expect(isExecutable(path)).toBe(true)
    expect(isExecutable(dir)).toBe(false)
    expect(isExecutable(join(dir, 'absent'))).toBe(false)
  })

  it('searches PATH in order and skips entries without the binary', async () => {
    const first = await scratch()
    const second = await scratch()
    await fakeBinary(second)
    const found = findOnPath({ PATH: `${first}:${second}` })
    expect(found).toBe(join(second, DAEMON_BINARY_NAME))
  })

  it('treats an empty PATH entry as the current directory', () => {
    // The binary is not in the working directory, so this must not throw.
    expect(findOnPath({ PATH: ':' })).toBeUndefined()
  })

  it('returns undefined when PATH is absent or empty', () => {
    expect(findOnPath({})).toBeUndefined()
    expect(findOnPath({ PATH: '' })).toBeUndefined()
  })

  it('prefers explicit configuration over everything else', async () => {
    const configured = await scratch()
    const onPath = await scratch()
    const configuredPath = await fakeBinary(configured)
    await fakeBinary(onPath)
    const resolved = resolveDaemonBinary(
      { binary: configuredPath, managedDir: '/nonexistent', vendoredDir: '/nonexistent-vendored' },
      { PATH: onPath, AGENTJAIL_BIN: join(onPath, DAEMON_BINARY_NAME) },
    )
    expect(resolved).toEqual({ path: configuredPath, source: 'config' })
  })

  it('treats a configured path as authoritative and never falls back to PATH', async () => {
    const dir = await scratch()
    const onPath = await scratch()
    await fakeBinary(onPath)
    // A missing configured binary is a misconfiguration; silently running a
    // different binary found on PATH would be the surprising outcome.
    expect(
      resolveDaemonBinary(
        {
          binary: join(dir, 'missing'),
          managedDir: '/nonexistent',
          vendoredDir: '/nonexistent-vendored',
        },
        { PATH: onPath },
      ),
    ).toBeUndefined()
  })

  it('names the configured path in the reason when it is unusable', async () => {
    const dir = await scratch()
    const supervisor = new DaemonSupervisor(options({ binary: join(dir, 'missing') }))
    const outcome = await supervisor.ensure(async () => false)
    expect(outcome.state).toBe('unavailable')
    expect(outcome.reason).toContain(join(dir, 'missing'))
  })

  it('prefers AGENTJAIL_BIN over PATH', async () => {
    const explicit = await scratch()
    const onPath = await scratch()
    const explicitPath = await fakeBinary(explicit)
    await fakeBinary(onPath)
    const resolved = resolveDaemonBinary(
      { binary: '', managedDir: '/nonexistent', vendoredDir: '/nonexistent-vendored' },
      { PATH: onPath, AGENTJAIL_BIN: explicitPath },
    )
    expect(resolved).toEqual({ path: explicitPath, source: 'environment' })
  })

  it('falls back to the managed directory last', async () => {
    const managed = await scratch()
    const managedPath = await fakeBinary(managed)
    const resolved = resolveDaemonBinary(
      { binary: '', managedDir: managed, vendoredDir: '/nonexistent-vendored' },
      { PATH: '/nonexistent-path' },
    )
    expect(resolved).toEqual({ path: managedPath, source: 'managed' })
  })

  it('reports nothing when no binary is anywhere', () => {
    expect(
      resolveDaemonBinary(
        { binary: '', managedDir: '/nonexistent', vendoredDir: '/nonexistent-vendored' },
        { PATH: '/nonexistent' },
      ),
    ).toBeUndefined()
  })

  it('derives the managed directory from HOME', () => {
    expect(defaultManagedDir({ HOME: '/home/example' })).toBe(
      '/home/example/.agentjail/dsh-plugin-agentjail/bin',
    )
  })

  it('detects a managed binary by presence', async () => {
    const managed = await scratch()
    expect(hasManagedBinary(managed)).toBe(false)
    await fakeBinary(managed)
    expect(hasManagedBinary(managed)).toBe(true)
  })
})

describe('daemon supervision', () => {
  it('adopts an already-running daemon without starting anything', async () => {
    const supervisor = new DaemonSupervisor(options())
    const probe = vi.fn().mockResolvedValue(true)
    const outcome = await supervisor.ensure(probe)
    expect(outcome).toEqual({ state: 'external', managed: false })
    expect(supervisor.managed).toBe(false)
    expect(supervisor.attempts).toBe(0)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not start a daemon when supervision is disabled', async () => {
    const supervisor = new DaemonSupervisor(options({ enabled: false }))
    const outcome = await supervisor.ensure(async () => false)
    expect(outcome.state).toBe('disabled')
    expect(outcome.managed).toBe(false)
    expect(outcome.reason).toContain('disabled')
  })

  it('reports unavailable when no binary can be found', async () => {
    const supervisor = new DaemonSupervisor(options({ managedDir: '/nonexistent' }))
    const outcome = await supervisor.ensure(async () => false)
    expect(outcome.state).toBe('unavailable')
    expect(outcome.reason).toContain('no agentjail binary found')
  })

  it('starts a daemon and reports it as managed once the probe answers', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), startTimeoutMs: 2000 }),
    )
    let calls = 0
    const outcome = await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    })
    expect(outcome.state).toBe('started')
    expect(outcome.managed).toBe(true)
    expect(supervisor.attempts).toBe(1)
    expect(supervisor.stop()).toBe(true)
  })

  it('reports failure when the daemon never answers in time', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({
        binary: join(dir, DAEMON_BINARY_NAME),
        startTimeoutMs: 150,
        pollIntervalMs: 20,
      }),
    )
    const outcome = await supervisor.ensure(async () => false)
    expect(['started', 'exited']).toContain(outcome.state)
    expect(outcome.reason).toBeDefined()
  })

  it('never signals a daemon it did not start', async () => {
    const supervisor = new DaemonSupervisor(options())
    await supervisor.ensure(async () => true)
    expect(supervisor.stop()).toBe(false)
  })

  it('stops a daemon it started exactly once', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), startTimeoutMs: 2000 }),
    )
    let calls = 0
    await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    })
    expect(supervisor.stop()).toBe(true)
    expect(supervisor.stop()).toBe(false)
  })

  it('exposes the resolved binary and its source after a pass', async () => {
    const dir = await scratch()
    const path = await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(options({ binary: path, startTimeoutMs: 1000 }))
    let calls = 0
    await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    })
    expect(supervisor.resolved).toEqual({ path, source: 'config' })
    supervisor.stop()
  })
})

/** A version reader that always reports a fixed version. */
function versionReader(text: string) {
  return async (
    _binary: string,
    window: { min: string; maxMajor: number },
  ): Promise<BinaryVersionCheck> => {
    const version = parseVersion(text)
    return { compatibility: classifyVersion(version, window), ...(version ? { version } : {}) }
  }
}

describe('vendored binary preference', () => {
  it('prefers the vendored build over one on PATH', async () => {
    const vendored = await scratch()
    const onPath = await scratch()
    const vendoredPath = await fakeBinary(vendored)
    await fakeBinary(onPath)
    const resolved = resolveDaemonBinary(
      { binary: '', managedDir: '/nonexistent', vendoredDir: vendored },
      { PATH: onPath },
    )
    // The plugin is tested against the build it ships, so that build wins over
    // whatever version happens to be on PATH.
    expect(resolved).toEqual({ path: vendoredPath, source: 'vendored' })
  })

  it('lets explicit configuration override the vendored build', async () => {
    const vendored = await scratch()
    const configured = await scratch()
    await fakeBinary(vendored)
    const configuredPath = await fakeBinary(configured)
    const resolved = resolveDaemonBinary(
      { binary: configuredPath, managedDir: '/nonexistent', vendoredDir: vendored },
      { PATH: '/nonexistent' },
    )
    expect(resolved).toEqual({ path: configuredPath, source: 'config' })
  })

  it('lets AGENTJAIL_BIN override the vendored build', async () => {
    const vendored = await scratch()
    const explicit = await scratch()
    await fakeBinary(vendored)
    const explicitPath = await fakeBinary(explicit)
    const resolved = resolveDaemonBinary(
      { binary: '', managedDir: '/nonexistent', vendoredDir: vendored },
      { PATH: '/nonexistent', AGENTJAIL_BIN: explicitPath },
    )
    expect(resolved).toEqual({ path: explicitPath, source: 'environment' })
  })
})

describe('version gating', () => {
  it('refuses to start a binary outside the supported window', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), requireSupportedVersion: true }),
    )
    const outcome = await supervisor.ensure(async () => false, versionReader('v9.9.9'))
    expect(outcome.state).toBe('incompatible')
    expect(outcome.managed).toBe(false)
    expect(outcome.reason).toContain('v9.9.9')
    // Nothing was started, so a broken release cannot become the engine.
    expect(supervisor.attempts).toBe(0)
  })

  it('refuses a binary older than the supported window', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), requireSupportedVersion: true }),
    )
    const outcome = await supervisor.ensure(async () => false, versionReader('v1.0.0'))
    expect(outcome.state).toBe('incompatible')
    expect(outcome.reason).toContain('predates')
  })

  it('refuses a binary whose version cannot be read', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), requireSupportedVersion: true }),
    )
    const outcome = await supervisor.ensure(async () => false, versionReader('dev build'))
    expect(outcome.state).toBe('incompatible')
    expect(outcome.reason).toContain('unknown')
  })

  it('starts a binary inside the supported window', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({
        binary: join(dir, DAEMON_BINARY_NAME),
        requireSupportedVersion: true,
        startTimeoutMs: 2000,
      }),
    )
    let calls = 0
    const outcome = await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    }, versionReader('v1.8.2'))
    expect(outcome.state).toBe('started')
    expect(supervisor.version?.version?.raw).toBe('v1.8.2')
    supervisor.stop()
  })

  it('starts an unverifiable binary when the check is disabled', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({
        binary: join(dir, DAEMON_BINARY_NAME),
        requireSupportedVersion: false,
        startTimeoutMs: 2000,
      }),
    )
    let calls = 0
    const outcome = await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    }, versionReader('v9.9.9'))
    expect(outcome.state).toBe('started')
    supervisor.stop()
  })

  it('honours an injected window', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({
        binary: join(dir, DAEMON_BINARY_NAME),
        requireSupportedVersion: true,
        versionWindow: { min: '2.0.0', maxMajor: 3 },
      }),
    )
    const outcome = await supervisor.ensure(async () => false, versionReader('v1.8.2'))
    expect(outcome.state).toBe('incompatible')
  })
})

describe('restart', () => {
  it('restarts a daemon it started', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), startTimeoutMs: 2000 }),
    )
    let calls = 0
    await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    })
    expect(supervisor.restart()).toBeTypeOf('number')
    supervisor.stop()
  })

  it('keeps ownership of a daemon it started across repeated passes', async () => {
    const dir = await scratch()
    await fakeBinary(dir)
    const supervisor = new DaemonSupervisor(
      options({ binary: join(dir, DAEMON_BINARY_NAME), startTimeoutMs: 2000 }),
    )
    let calls = 0
    await supervisor.ensure(async () => {
      calls += 1
      return calls > 1
    })
    expect(supervisor.managed).toBe(true)
    // A second pass with a healthy daemon must not disown it, or `stop()` would
    // leave the process running and reload would stop being attempted.
    const second = await supervisor.ensure(async () => true)
    expect(second.state).toBe('started')
    expect(second.managed).toBe(true)
    expect(supervisor.stop()).toBe(true)
  })

  it('refuses to restart a daemon it did not start', async () => {
    const supervisor = new DaemonSupervisor(options())
    await supervisor.ensure(async () => true)
    expect(supervisor.restart()).toBeUndefined()
  })

  it('refuses to restart when no daemon is running', () => {
    expect(new DaemonSupervisor(options()).restart()).toBeUndefined()
  })
})
