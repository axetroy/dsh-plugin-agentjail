/**
 * AgentJail version identity and compatibility.
 *
 * The plugin is a client of a wire contract that upstream versioned `v1` and
 * promised never to change in place. A version check is still worth having,
 * because "the contract did not change" is a promise about the bytes, not about
 * the process: a future release can add a required flag, rename the daemon
 * subcommand, or stop serving a control operation, and none of those are
 * contract breaks upstream is obliged to avoid.
 *
 * Two things are checked:
 *
 * 1. **The binary.** `agentjail version` names the build the plugin is about to
 *    start. A build outside the supported window is refused before it runs, so a
 *    broken release cannot become the plugin's engine.
 * 2. **The daemon.** A successful control ping reports the running daemon's
 *    version. That is the process actually answering, and it is the one that
 *    matters when an operator's own daemon is the one being adopted.
 *
 * A version that cannot be parsed is reported as `unknown`, never as `ok`.
 * @module dsh-plugin-agentjail/adapter/version
 */

/** A parsed semantic version. */
export interface AgentJailVersion {
  major: number
  minor: number
  patch: number
  /** The version as it appeared, e.g. `v1.8.2`. */
  raw: string
}

/** How a version relates to the window this plugin was built against. */
export type VersionCompatibility =
  /** Inside the supported window. */
  | 'ok'
  /** Older than the oldest build this plugin supports. */
  | 'too-old'
  /** Newer than the newest build this plugin was verified against. */
  | 'too-new'
  /** No version could be read at all. */
  | 'unknown'

/** A half-open supported window: `min <= version < max`. */
export interface VersionWindow {
  /** Oldest supported version, inclusive. */
  min: string
  /** First unsupported major version, exclusive. */
  maxMajor: number
}

/**
 * The window this plugin is built and tested against.
 *
 * The lower bound is the release whose control-socket reload and inline default
 * policy the plugin relies on. The upper bound is the next major version:
 * upstream treats a major bump as the point where the v1 contract may be
 * retired, so crossing it requires a plugin release that has verified the new
 * contract rather than an operator discovering the break at runtime.
 */
export const SUPPORTED_VERSION_WINDOW: VersionWindow = { min: '1.8.0', maxMajor: 2 }

/**
 * Match a version anywhere in a string.
 *
 * Upstream prints a styled banner rather than a bare number, so the version has
 * to be found inside surrounding text. An optional leading `v` and an optional
 * pre-release suffix are accepted; the suffix is ignored for ordering.
 */
const VERSION_PATTERN = /(?<![0-9])v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/

/**
 * Read the first semantic version out of a string.
 * @param text - the text to scan, such as `agentjail version` output.
 * @returns the parsed version, or `undefined` when none is present.
 */
export function parseVersion(text: string): AgentJailVersion | undefined {
  const match = VERSION_PATTERN.exec(text)
  if (match === null) return undefined
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    raw: match[0],
  }
}

/**
 * Order two versions.
 * @param left - the first version.
 * @param right - the second version.
 * @returns a negative number when `left < right`, `0` when equal, positive otherwise.
 */
export function compareVersions(left: AgentJailVersion, right: AgentJailVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

/**
 * Classify a version against a supported window.
 * @param version - the version to classify, or `undefined` when none was read.
 * @param window - the supported window.
 * @returns how the version relates to the window.
 */
export function classifyVersion(
  version: AgentJailVersion | undefined,
  window: VersionWindow = SUPPORTED_VERSION_WINDOW,
): VersionCompatibility {
  if (version === undefined) return 'unknown'
  if (version.major >= window.maxMajor) return 'too-new'
  const floor = parseVersion(window.min)
  if (floor !== undefined && compareVersions(version, floor) < 0) return 'too-old'
  return 'ok'
}

/**
 * Report whether a version is inside a supported window.
 * @param version - the version to test, or `undefined` when none was read.
 * @param window - the supported window.
 * @returns whether the version is supported.
 */
export function isVersionSupported(
  version: AgentJailVersion | undefined,
  window: VersionWindow = SUPPORTED_VERSION_WINDOW,
): boolean {
  return classifyVersion(version, window) === 'ok'
}

/**
 * Describe a compatibility outcome for an operator.
 * @param compatibility - the outcome to describe.
 * @param window - the supported window the outcome is relative to.
 * @returns a single sentence naming the window.
 */
export function describeCompatibility(
  compatibility: VersionCompatibility,
  window: VersionWindow = SUPPORTED_VERSION_WINDOW,
): string {
  const supported = `>=${window.min} <${window.maxMajor}.0.0`
  switch (compatibility) {
    case 'ok':
      return `the version is supported (${supported})`
    case 'too-old':
      return `the version predates the supported window (${supported})`
    case 'too-new':
      return `the version is newer than the plugin has been verified against (${supported})`
    case 'unknown':
      return 'no version could be read'
  }
}
