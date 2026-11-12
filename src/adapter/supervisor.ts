/**
 * AgentJail daemon supervision.
 *
 * The plugin talks to a policy daemon over a Unix socket. When that socket is
 * already answering, this module does nothing: a daemon the operator started
 * through systemd, launchd, or the official installer is left entirely alone.
 * Only when the socket is dead does it locate an `agentjail` binary and start
 * one, so a machine that has AgentJail installed does not also need a separate
 * "start the daemon" step before the plugin is useful.
 *
 * Two rules shape the design:
 *
 * 1. **Never adopt a daemon we did not start.** `stop()` signals only the child
 *    this process spawned. A daemon owned by the operator's supervisor keeps
 *    running, so unloading the plugin cannot take protection away from another
 *    session.
 * 2. **Never turn supervision into an allow.** Failing to find or start a binary
 *    is reported, and the caller keeps applying the configured failure action.
 * @module dsh-plugin-agentjail/adapter/supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Where a located `agentjail` binary came from. */
export type BinarySource = 'config' | 'environment' | 'path' | 'managed'

/** A located daemon binary. */
export interface BinaryResolution {
  /** Absolute path to the executable. */
  path: string
  /** How the path was found, for diagnostics. */
  source: BinarySource
}

/** What the supervisor is currently relying on for policy. */
export type SupervisionState =
  /** An operator-managed daemon is answering; the plugin started nothing. */
  | 'external'
  /** This process started a daemon and it is answering. */
  | 'started'
  /** A daemon this process started has since exited. */
  | 'exited'
  /** No daemon is answering and none could be started. */
  | 'unavailable'
  /** Supervision is disabled by configuration. */
  | 'disabled'

/** Result of one supervision pass. */
export interface SupervisionOutcome {
  /** What the plugin is relying on after the pass. */
  state: SupervisionState
  /** Whether this process is responsible for the running daemon. */
  managed: boolean
  /** The located binary, when one was found. */
  binary?: BinaryResolution
  /** Why supervision could not establish a daemon, when it could not. */
  reason?: string
}

/** Supervisor tuning, sourced from plugin configuration. */
export interface SupervisorOptions {
  /** Whether to start a daemon when none is answering. */
  enabled: boolean
  /** Explicit binary path; empty falls back to environment, then `PATH`. */
  binary: string
  /** Resolved daemon socket path, used to detect an already-running daemon. */
  socketPath: string
  /** Directory holding a plugin-downloaded binary. */
  managedDir: string
  /** Arguments used to start the daemon. */
  args: string[]
  /** How long to wait for a started daemon to answer, in milliseconds. */
  startTimeoutMs: number
  /** How long to wait between readiness probes, in milliseconds. */
  pollIntervalMs: number
}

/** Default argument vector; `agentjail daemon` runs the daemon role. */
export const DEFAULT_DAEMON_ARGS: readonly string[] = ['daemon']

/** Executable name searched for on `PATH`. */
export const DAEMON_BINARY_NAME = 'agentjail'

/**
 * Test whether a path is an executable regular file.
 *
 * The file check matters: a directory is executable on POSIX, so `X_OK` alone
 * would accept a directory whose name happens to match the binary.
 * @param path - candidate path.
 * @returns whether the path exists, is a regular file, and is executable.
 */
export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Search `PATH` for the daemon binary.
 *
 * An explicit `PATH` entry may be a directory or a full file path, so both are
 * tried; an empty entry means the current directory, matching `execvp`.
 * @param env - the environment to read `PATH` from.
 * @returns the first executable match, or `undefined`.
 */
export function findOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['PATH']
  if (raw === undefined || raw.length === 0) return undefined
  for (const entry of raw.split(delimiter)) {
    const directory = entry.length > 0 ? entry : '.'
    const candidate = join(directory, DAEMON_BINARY_NAME)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate the daemon binary.
 *
 * Precedence is explicit configuration, then `AGENTJAIL_BIN`, then `PATH`, then
 * the plugin's managed download directory. Configuration wins so a deployment
 * can pin an exact build; `PATH` is consulted last-but-one because a shim on
 * `PATH` is the normal outcome of the official installer.
 * @param options - supervisor tuning.
 * @param env - the environment to consult.
 * @returns the resolved binary, or `undefined` when none is usable.
 */
export function resolveDaemonBinary(
  options: Pick<SupervisorOptions, 'binary' | 'managedDir'>,
  env: NodeJS.ProcessEnv = process.env,
): BinaryResolution | undefined {
  if (options.binary.length > 0) {
    return isExecutable(options.binary) ? { path: options.binary, source: 'config' } : undefined
  }
  const fromEnvironment = env['AGENTJAIL_BIN']
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return isExecutable(fromEnvironment)
      ? { path: fromEnvironment, source: 'environment' }
      : undefined
  }
  const onPath = findOnPath(env)
  if (onPath !== undefined) return { path: onPath, source: 'path' }
  const managed = join(options.managedDir, DAEMON_BINARY_NAME)
  if (isExecutable(managed)) return { path: managed, source: 'managed' }
  return undefined
}

/** The default managed download directory, under AgentJail's own state root. */
export function defaultManagedDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? homedir()
  return join(home, '.agentjail', 'dsh-plugin-agentjail', 'bin')
}

/**
 * Start a daemon and wait until it answers.
 *
 * The child is detached and unreferenced so it outlives neither our interest in
 * it nor the process, and so a plugin unload does not tear down a daemon that
 * another session may be relying on.
 */
export class DaemonSupervisor {
  private child: ChildProcess | undefined
  private readonly spawned = new Set<ChildProcess>()
  private state: SupervisionState = 'disabled'
  private binary: BinaryResolution | undefined
  private lastReason: string | undefined
  private startAttempts = 0

  constructor(private readonly options: SupervisorOptions) {}

  /** The current supervision state. */
  get current(): SupervisionState {
    return this.state
  }

  /** The located binary, once resolution has run. */
  get resolved(): BinaryResolution | undefined {
    return this.binary
  }

  /** Whether this process started the daemon it is relying on. */
  get managed(): boolean {
    return this.state === 'started'
  }

  /** Why supervision could not establish a daemon, when it could not. */
  get reason(): string | undefined {
    return this.lastReason
  }

  /** The pid of the daemon this process started, when it is still running. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Ensure a daemon is answering, starting one when necessary.
   * @param probe - a liveness check that resolves true when the daemon answers.
   * @returns what the plugin is relying on after the pass.
   */
  async ensure(probe: () => Promise<boolean>): Promise<SupervisionOutcome> {
    if (await probe()) {
      this.state = 'external'
      this.lastReason = undefined
      return { state: 'external', managed: false, ...(this.binary ? { binary: this.binary } : {}) }
    }

    if (!this.options.enabled) {
      this.state = 'disabled'
      this.lastReason = 'daemon supervision is disabled and no daemon is answering'
      return { state: 'disabled', managed: false, reason: this.lastReason }
    }

    this.binary = resolveDaemonBinary(this.options)
    if (this.binary === undefined) {
      this.state = 'unavailable'
      // A configured path is authoritative: it is never silently replaced by a
      // different binary found on PATH, so the reason names it.
      this.lastReason =
        this.options.binary.length > 0
          ? `configured daemon binary is not an executable file: ${this.options.binary}`
          : 'no agentjail binary found (set daemon.binary, AGENTJAIL_BIN, or install agentjail)'
      return { state: 'unavailable', managed: false, reason: this.lastReason }
    }

    this.spawnDaemon()
    const ready = await this.awaitReady(probe)
    if (ready) {
      this.state = 'started'
      this.lastReason = undefined
      return { state: 'started', managed: true, binary: this.binary }
    }

    this.state = this.child?.exitCode === null ? 'started' : 'exited'
    this.lastReason =
      this.child?.exitCode === null
        ? `daemon did not answer within ${this.options.startTimeoutMs}ms`
        : `daemon exited with code ${this.child?.exitCode} before answering`
    return {
      state: this.state,
      managed: this.state === 'started',
      binary: this.binary,
      reason: this.lastReason,
    }
  }

  /**
   * Spawn the daemon as a detached, unreferenced child.
   *
   * A child this supervisor already started and that has not exited is reused
   * rather than duplicated: two `ensure` calls racing on the same dead socket
   * must not leave one daemon unsupervised and unkillable.
   */
  private spawnDaemon(): void {
    if (this.binary === undefined) return
    if (this.child !== undefined && this.child.exitCode === null) return
    this.startAttempts += 1
    const child = spawn(this.binary.path, this.options.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGENTJAIL_SOCKET: this.options.socketPath },
    })
    child.on('error', () => {
      this.spawned.delete(child)
      if (this.child === child) this.child = undefined
    })
    child.on('exit', () => {
      this.spawned.delete(child)
      if (this.state === 'started') this.state = 'exited'
    })
    child.unref()
    this.child = child
    this.spawned.add(child)
  }

  /**
   * Poll until the daemon answers or the budget elapses.
   * @param probe - the liveness check.
   * @returns whether the daemon answered in time.
   */
  private async awaitReady(probe: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + this.options.startTimeoutMs
    const interval = Math.max(this.options.pollIntervalMs, 1)
    while (Date.now() < deadline) {
      if (this.child !== undefined && this.child.exitCode !== null) return false
      if (await probe()) return true
      await delay(interval)
    }
    return false
  }

  /**
   * Stop the daemon this process started.
   *
   * A daemon this process did not start is never signalled, and an already
   * exited child is not signalled twice.
   * @returns whether a process was signalled.
   */
  stop(): boolean {
    const children = [...this.spawned]
    this.child = undefined
    this.spawned.clear()
    if (this.state === 'started') this.state = 'exited'
    let signalled = false
    for (const child of children) {
      if (child.exitCode !== null || child.pid === undefined) continue
      try {
        // Detached children lead their own process group, so the negative pid
        // reaches the daemon and anything it started, and nothing else.
        process.kill(-child.pid, 'SIGTERM')
        signalled = true
      } catch {
        try {
          child.kill('SIGTERM')
          signalled = true
        } catch {
          // The process is already gone; nothing to signal.
        }
      }
    }
    return signalled
  }

  /** How many times this supervisor has spawned a daemon. */
  get attempts(): number {
    return this.startAttempts
  }
}

/** Wait for a fixed interval. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Report whether the managed binary directory holds a downloaded binary.
 * @param managedDir - the directory to inspect.
 * @returns whether an executable is present.
 */
export function hasManagedBinary(managedDir: string): boolean {
  return existsSync(join(managedDir, DAEMON_BINARY_NAME))
}
