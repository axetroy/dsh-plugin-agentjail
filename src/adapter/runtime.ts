/**
 * Where the plugin's AgentJail engine lives, and how it is started.
 *
 * The plugin ships the AgentJail build it was verified against, so installing
 * the plugin installs the engine: there is no separate install step and no
 * second version to keep in step. Two consequences shape this module.
 *
 * 1. **The binary is pinned, not discovered.** A vendored build under the
 *    package's own `vendor/` directory is preferred over whatever happens to be
 *    on `PATH`, because a plugin that is tested against one build should run
 *    that build. An operator who wants a different one sets `daemon.binary`, and
 *    that still wins.
 * 2. **The daemon is isolated.** A plugin-managed daemon gets its own socket,
 *    database, log, policy directory, and `HOME`. Upstream resolves its state
 *    root from `HOME`, so a private `HOME` is what keeps a plugin-managed daemon
 *    from colliding with an AgentJail the operator installed for their own use.
 * @module dsh-plugin-agentjail/adapter/runtime
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package name used to recognize the plugin's own package root. */
const PACKAGE_NAME = 'dsh-plugin-agentjail'

/** Executable name inside a vendored platform directory. */
export const DAEMON_EXECUTABLE = 'agentjail'

/** Node architecture names mapped onto upstream's release naming. */
const ARCHITECTURE_ALIASES: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
}

/** Platforms the plugin vendors a build for. */
const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin'])

/** The `<platform>-<arch>` label upstream and this package use for a build. */
export interface PlatformLabel {
  platform: string
  arch: string
}

/**
 * Map a Node platform and architecture onto the vendored directory label.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the label, or `undefined` for a platform with no vendored build.
 */
export function platformLabel(platform: string, arch: string): PlatformLabel | undefined {
  if (!SUPPORTED_PLATFORMS.has(platform)) return undefined
  const mapped = ARCHITECTURE_ALIASES[arch]
  if (mapped === undefined) return undefined
  return { platform, arch: mapped }
}

/** Every path the plugin's private daemon runtime uses. */
export interface RuntimePaths {
  /** Root of the plugin's AgentJail state. */
  root: string
  /** Private `HOME` the daemon runs under. */
  home: string
  /** Directory holding the daemon socket, database, and log. */
  run: string
  /** Directory holding the daemon's policy overlay. */
  policy: string
  /** Directory a managed binary is installed into. */
  bin: string
  /** Daemon's agent-facing socket. */
  socketPath: string
  /** Daemon's SQLite event store. */
  databasePath: string
  /** Daemon's rotating structured log. */
  logPath: string
  /** Daemon's `policy.yaml` overlay path. */
  policyPath: string
  /** Daemon's privileged control socket, derived from the private `HOME`. */
  controlSocketPath: string
  /** Control token guarding the privileged control socket. */
  controlTokenPath: string
}

/**
 * The plugin's default state directory.
 *
 * It sits beside upstream's own state root so both are easy to find, but in a
 * subdirectory of its own: the plugin never writes to `~/.agentjail` itself,
 * which is what lets an operator's own AgentJail install keep working.
 * @param env - the environment to read `HOME` from.
 * @returns the absolute state directory.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? homedir()
  return join(home, '.agentjail', PACKAGE_NAME)
}

/**
 * Compute every runtime path from a state directory.
 *
 * Paths are derived rather than configured one by one, so the socket, the
 * database, and the control token can never disagree about which daemon they
 * belong to.
 * @param stateDir - the state directory; an empty value uses the default.
 * @param env - the environment to read `HOME` from when no directory is given.
 * @returns the resolved paths.
 */
export function resolveRuntimePaths(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const root = resolve(stateDir.length > 0 ? stateDir : defaultStateDir(env))
  const home = join(root, 'home')
  const run = join(root, 'run')
  const policy = join(root, 'policy')
  // Upstream derives its state root from HOME, so the control socket and token
  // land under the private HOME rather than under `root`.
  const agentjailState = join(home, '.agentjail')
  return {
    root,
    home,
    run,
    policy,
    bin: join(root, 'bin'),
    socketPath: join(run, 'daemon.sock'),
    databasePath: join(run, 'agentjail.db'),
    logPath: join(run, 'daemon.log'),
    policyPath: join(policy, 'policy.yaml'),
    controlSocketPath: join(agentjailState, 'run', 'daemon-ctl.sock'),
    controlTokenPath: join(agentjailState, 'control.token'),
  }
}

/**
 * Build the environment a plugin-managed daemon runs under.
 *
 * The private `HOME` is the load-bearing part: it is what redirects every path
 * upstream derives, including the control socket and token. The two switches
 * turn off upstream's outbound update check and anonymous telemetry, because a
 * plugin that pins a verified build should not have that build replace itself,
 * and a security plugin should not emit usage data on an operator's behalf
 * without asking.
 * @param paths - the resolved runtime paths.
 * @param base - the environment to inherit from.
 * @returns the environment for the daemon process.
 */
export function daemonEnvironment(
  paths: RuntimePaths,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: paths.home,
    AGENTJAIL_SOCKET: paths.socketPath,
    AGENTJAIL_NO_UPDATE_CHECK: '1',
    AGENTJAIL_SEND_ANONYMOUS_USAGE_STATS: '0',
  }
}

/**
 * Build the argument vector a plugin-managed daemon is started with.
 *
 * `--socket`, `--db`, and `--log` are passed explicitly rather than left to the
 * daemon's own `HOME`-derived defaults. Upstream's daemon does not read
 * `AGENTJAIL_SOCKET`, so relying on the environment variable alone would start a
 * daemon on a different socket than the plugin connects to.
 * @param paths - the resolved runtime paths.
 * @param subcommand - the role to run; defaults to `daemon`.
 * @param extra - additional arguments appended verbatim.
 * @returns the argument vector.
 */
export function daemonArguments(
  paths: RuntimePaths,
  subcommand: string = 'daemon',
  extra: readonly string[] = [],
): string[] {
  return [
    subcommand,
    '--socket',
    paths.socketPath,
    '--db',
    paths.databasePath,
    '--log',
    paths.logPath,
    ...extra,
  ]
}

/**
 * Test whether a path is an executable regular file.
 * @param path - candidate path.
 * @returns whether the path exists, is a regular file, and is executable.
 */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Walk up from a directory until the plugin's own `package.json` is found.
 *
 * The vendored directory is resolved this way rather than from a fixed relative
 * offset, because the bundler decides how deep the module that calls this ends
 * up. Walking up finds the package root in a checkout and in an installed
 * package alike.
 * @param start - directory to begin at.
 * @returns the package root, or `undefined` when it could not be found.
 */
export function findPackageRoot(start: string): string | undefined {
  let current = resolve(start)
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          (parsed as { name?: unknown }).name === PACKAGE_NAME
        ) {
          return current
        }
      } catch {
        // An unreadable or malformed manifest is not this package's root.
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Locate the vendored binary for a platform.
 *
 * The layout is `vendor/<platform>-<arch>/agentjail`, matching the release
 * asset naming so a downloaded archive drops straight in.
 * @param packageRoot - the plugin's package root.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the binary path, or `undefined` when no vendored build is present.
 */
export function vendoredBinaryPath(
  packageRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const label = platformLabel(platform, arch)
  if (label === undefined) return undefined
  const candidate = join(
    packageRoot,
    'vendor',
    `${label.platform}-${label.arch}`,
    DAEMON_EXECUTABLE,
  )
  return isExecutableFile(candidate) ? candidate : undefined
}

/**
 * The directory a vendored build would live in, whether or not it exists.
 * @param packageRoot - the plugin's package root.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the directory path.
 */
export function vendoredDirectory(
  packageRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const label = platformLabel(platform, arch)
  const name = label === undefined ? `${platform}-${arch}` : `${label.platform}-${label.arch}`
  return join(packageRoot, 'vendor', name)
}

/**
 * Resolve the plugin's package root from this module's location.
 * @returns the package root, or `undefined` when it could not be determined.
 */
export function currentPackageRoot(): string | undefined {
  try {
    return findPackageRoot(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}
