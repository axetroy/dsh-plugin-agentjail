/**
 * AgentJail daemon supervision.
 *
 * The plugin ships the AgentJail build it was verified against, and starts a
 * daemon of its own from it. That is what makes installing the plugin sufficient:
 * there is no second install step, and no separately-updated binary to drift out
 * of step with the plugin's expectations.
 *
 * A daemon the operator started is still honored when it is already answering at
 * the configured socket, because taking over a socket that something else owns
 * would be worse than using it.
 *
 * Three rules shape the design:
 *
 * 1. **Never adopt a daemon we did not start.** `stop()` signals only the child
 *    this process spawned. A daemon owned by the operator's supervisor keeps
 *    running, so unloading the plugin cannot take protection away from another
 *    session.
 * 2. **Never turn supervision into an allow.** Failing to find, verify, or start a
 *    binary is reported, and the caller keeps applying the configured failure
 *    action.
 * 3. **Never start a build we cannot vouch for.** A binary whose version is
 *    outside the supported window is refused before it runs, so a broken or
 *    unexpected release cannot silently become the plugin's policy engine.
 * @module dsh-plugin-agentjail/adapter/supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  classifyVersion,
  describeCompatibility,
  parseVersion,
  SUPPORTED_VERSION_WINDOW,
  type AgentJailVersion,
  type VersionCompatibility,
  type VersionWindow,
} from './version.js'
import { daemonArguments, daemonEnvironment, resolveRuntimePaths } from './runtime.js'

/** Where a located `agentjail` binary came from. */
export type BinarySource = 'config' | 'environment' | 'vendored' | 'path' | 'managed'

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
  /** A binary was found but its version is outside the supported window. */
  | 'incompatible'

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
  /** Directory holding a binary vendored with the plugin. */
  vendoredDir: string
  /** Plugin's private AgentJail state directory. */
  stateDir: string
  /** Arguments used to start the daemon. */
  args: string[]
  /** How long to wait for a started daemon to answer, in milliseconds. */
  startTimeoutMs: number
  /** How long to wait between readiness probes, in milliseconds. */
  pollIntervalMs: number
  /**
   * Whether a binary outside the supported version window is refused.
   *
   * A vendored binary is pinned by the package, so this is what stops an
   * operator's `PATH` build from silently becoming the engine. Turning it off is
   * an explicit acceptance of that risk, which is why the default is on.
   */
  requireSupportedVersion: boolean
  /** Window the version check is applied against; injected for tests. */
  versionWindow?: { min: string; maxMajor: number }
}

/** Outcome of reading a binary's version. */
export interface BinaryVersionCheck {
  /** The version the binary reported, when it reported one. */
  version?: AgentJailVersion
  /** How the version relates to the supported window. */
  compatibility: VersionCompatibility
  /** Why the version could not be read, when it could not. */
  error?: string
}

/**
 * Read a binary's version by running `<binary> --no-color version`.
 *
 * `--no-color` keeps the banner free of ANSI escapes, which would otherwise sit
 * between the version and the text around it. The version is parsed out of the
 * banner rather than expected alone on a line, because upstream prints a styled
 * header.
 * @param binary - path to the executable.
 * @param run - process runner, injected so tests need no real binary.
 * @param window - supported window the version is classified against.
 * @returns the check result; never throws.
 */
export async function checkBinaryVersion(
  binary: string,
  run: (file: string, args: string[]) => Promise<string> = defaultRunVersion,
  window: VersionWindow = SUPPORTED_VERSION_WINDOW,
): Promise<BinaryVersionCheck> {
  let output: string
  try {
    output = await run(binary, ['--no-color', 'version'])
  } catch (error) {
    return {
      compatibility: 'unknown',
      error: `could not run ${binary} version: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const version = parseVersion(output)
  const compatibility = classifyVersion(version, window)
  return version === undefined
    ? { compatibility, error: `could not parse a version from "${output.trim().slice(0, 120)}"` }
    : { version, compatibility }
}

/** Run a binary and return its combined output. */
async function defaultRunVersion(file: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const result = await promisify(execFile)(file, args, { timeout: 5000 })
  return `${result.stdout}${result.stderr}`
}

/** Default version verifier: run the binary and classify what it reports. */
function defaultVerifier(binary: string, window: VersionWindow): Promise<BinaryVersionCheck> {
  return checkBinaryVersion(binary, defaultRunVersion, window)
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
 * Precedence is explicit configuration, then `AGENTJAIL_BIN`, then the build
 * vendored with this plugin, then `PATH`, then the managed download directory.
 *
 * The vendored build sits above `PATH` deliberately. The plugin is tested
 * against the build it ships, so that build is the one whose behavior the
 * plugin's own guarantees describe; a `PATH` build may be any version at all.
 * Configuration still wins, so an operator who wants a specific build gets it.
 * @param options - supervisor tuning.
 * @param env - the environment to consult.
 * @returns the resolved binary, or `undefined` when none is usable.
 */
export function resolveDaemonBinary(
  options: Pick<SupervisorOptions, 'binary' | 'managedDir' | 'vendoredDir'>,
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
  const vendored = join(options.vendoredDir, DAEMON_BINARY_NAME)
  if (isExecutable(vendored)) return { path: vendored, source: 'vendored' }
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
  private versionCheck: BinaryVersionCheck | undefined

  constructor(private readonly options: SupervisorOptions) {}

  /** The current supervision state. */
  get current(): SupervisionState {
    return this.state
  }

  /** The version check performed on the last resolved binary, if any. */
  get version(): BinaryVersionCheck | undefined {
    return this.versionCheck
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
   * @param verify - version reader used to gate a binary before it is started.
   * @returns what the plugin is relying on after the pass.
   */
  async ensure(
    probe: () => Promise<boolean>,
    verify: (
      binary: string,
      window: VersionWindow,
    ) => Promise<BinaryVersionCheck> = defaultVerifier,
  ): Promise<SupervisionOutcome> {
    if (await probe()) {
      // A daemon this process started and that is still alive stays "started".
      // Reporting it as "external" would disown it: `stop()` would no longer
      // signal it and reload would no longer be attempted, so a second `ensure`
      // call on a healthy managed daemon would quietly orphan it.
      if (this.child !== undefined && this.child.exitCode === null) {
        this.state = 'started'
        this.lastReason = undefined
        return { state: 'started', managed: true, ...(this.binary ? { binary: this.binary } : {}) }
      }
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

    const window = this.options.versionWindow ?? SUPPORTED_VERSION_WINDOW
    const check = await verify(this.binary.path, window)
    this.versionCheck = check
    if (this.options.requireSupportedVersion && check.compatibility !== 'ok') {
      this.state = 'incompatible'
      const observed = check.version?.raw ?? 'unknown'
      this.lastReason = `agentjail at ${this.binary.path} reports ${observed}: ${describeCompatibility(
        check.compatibility,
        window,
      )}${check.error !== undefined ? ` (${check.error})` : ''}`
      return { state: 'incompatible', managed: false, binary: this.binary, reason: this.lastReason }
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
   *
   * The daemon is given a private state directory and `HOME` so it cannot
   * collide with an AgentJail the operator installed for their own use, and the
   * socket, database, and log are passed as explicit flags rather than left to
   * the daemon's `HOME`-derived defaults.
   */
  private spawnDaemon(): void {
    if (this.binary === undefined) return
    if (this.child !== undefined && this.child.exitCode === null) return
    this.startAttempts += 1
    const paths = resolveRuntimePaths(this.options.stateDir)
    const args = daemonArguments(
      paths,
      this.options.args[0] ?? 'daemon',
      this.options.args.slice(1),
    )
    const child = spawn(this.binary.path, args, {
      detached: true,
      stdio: 'ignore',
      env: daemonEnvironment(paths),
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
   * Stop the daemon this process started and start a fresh one.
   *
   * Used to pick up a policy change when the control plane is unreachable. It
   * only ever acts on a daemon this process started: an operator-managed daemon
   * is not this plugin's to restart.
   * @returns the new child's pid, or `undefined` when nothing was restarted.
   */
  restart(): number | undefined {
    if (this.state !== 'started') return undefined
    this.stop()
    this.spawnDaemon()
    // `stop()` left the state at `exited`; the replacement is ours too, so
    // reclaim ownership. The exit handler still demotes this to `exited` if the
    // new child dies, so the state stays truthful either way.
    if (this.child?.exitCode === null) this.state = 'started'
    return this.child?.pid
  }

  /**
   * Poll until the daemon answers or the budget elapses.
   * @param probe - the liveness check.
   * @returns whether the daemon answered in time.
   */
  async awaitReady(probe: () => Promise<boolean>): Promise<boolean> {
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
