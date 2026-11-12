/**
 * Opt-in download of a managed AgentJail binary.
 *
 * This exists so a machine without AgentJail can get one without a manual
 * install step. It is off by default and stays off unless a deployment asks for
 * it, because downloading and executing a release binary is a trust decision
 * that belongs to the operator rather than to a plugin's default behavior.
 *
 * Every step fails closed:
 *
 * - The release manifest is fetched from a fixed, overridable URL and must carry
 *   a SHA-256 entry for the platform archive. An archive with no entry is not
 *   installed, so a tampered or truncated manifest cannot silently authorize a
 *   download.
 * - The archive's digest must equal the manifest's, or the file is discarded and
 *   nothing is installed.
 * - The extracted binary is written to the managed directory under a temporary
 *   name and renamed into place, so a partial extraction never becomes the
 *   binary that gets executed.
 *
 * The upstream release also publishes a `minisign` signature over the manifest.
 * Verifying that needs a signature tool, which cannot be assumed present, so this
 * module verifies the digest the manifest asserts and documents the residual gap
 * rather than implying a signature check that did not happen.
 * @module dsh-plugin-agentjail/adapter/installer
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default release base URL for the upstream AgentJail repository. */
export const DEFAULT_RELEASE_BASE_URL = 'https://github.com/LuD1161/agentjail/releases/download'

/** Platforms with published release archives. */
const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin'])

/** Architectures with published release archives, mapped to release naming. */
const ARCHITECTURE_ALIASES: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
}

/** Outcome of a managed install attempt. */
export interface InstallResult {
  /** Whether a binary was installed. */
  installed: boolean
  /** Absolute path of the installed binary, when one was. */
  path?: string
  /** Version label that was installed, when known. */
  version?: string
  /** Why nothing was installed, when nothing was. */
  reason?: string
}

/** Installer tuning, sourced from plugin configuration. */
export interface InstallerOptions {
  /** Release version to install, e.g. `v1.8.2`; empty uses the latest release. */
  version: string
  /** Base URL serving `<base>/<tag>/<asset>`. */
  releaseBaseUrl: string
  /** Directory the binary is installed into. */
  managedDir: string
  /** Download budget in milliseconds. */
  timeoutMs: number
  /** Maximum accepted archive size in bytes. */
  maxArchiveBytes: number
}

/** Platform facts the installer needs, injected so tests need no host variation. */
export interface PlatformFacts {
  platform: string
  arch: string
}

/**
 * Map a Node platform and architecture onto the upstream release asset name.
 * @param facts - the platform and architecture to map.
 * @param version - the release tag, e.g. `v1.8.2`.
 * @returns the archive file name, or `undefined` when unsupported.
 */
export function archiveName(facts: PlatformFacts, version: string): string | undefined {
  if (!SUPPORTED_PLATFORMS.has(facts.platform)) return undefined
  const arch = ARCHITECTURE_ALIASES[facts.arch]
  if (arch === undefined) return undefined
  return `agentjail-${version}-${facts.platform}-${arch}.tar.gz`
}

/**
 * Read one asset's expected digest from a `SHA256SUMS` manifest.
 *
 * The manifest format is `<hex digest><whitespace><file name>` per line, with an
 * optional leading `*` before the name for binary mode.
 * @param manifest - the manifest text.
 * @param asset - the asset file name to look up.
 * @returns the lowercase hex digest, or `undefined` when absent.
 */
export function digestFromManifest(manifest: string, asset: string): string | undefined {
  for (const line of manifest.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed)
    if (match === null) continue
    const [, digest, name] = match
    if (name?.trim() === asset && digest !== undefined) return digest.toLowerCase()
  }
  return undefined
}

/**
 * Compute the SHA-256 digest of a buffer.
 * @param data - the bytes to hash.
 * @returns the lowercase hex digest.
 */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Fetch a URL, refusing a body larger than the ceiling. */
async function fetchBytes(url: string, timeoutMs: number, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`)
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${url} returned ${buffer.byteLength} bytes, exceeding the ${maxBytes} limit`)
  }
  return buffer
}

/**
 * Extract one member from a gzipped tar archive.
 *
 * The extraction runs through the system `tar`, which is present on every
 * supported platform. Only the requested member is written, and it is written
 * into a directory created for this install.
 * @param archive - path to the `.tar.gz` file.
 * @param member - the member to extract, or the basename to match anywhere.
 * @param destination - directory to extract into.
 * @returns the extracted file's path.
 */
export async function extractMember(
  archive: string,
  member: string,
  destination: string,
): Promise<string> {
  const target = join(destination, member)
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', destination, member])
  } catch (error) {
    // The release archives nest the binary under a directory, so fall back to a
    // name match that ignores the leading path.
    try {
      await execFileAsync('tar', [
        '-xzf',
        archive,
        '-C',
        destination,
        '--strip-components=1',
        '--wildcards',
        `*/${member}`,
      ])
    } catch {
      throw new Error(
        `archive does not contain ${member}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!existsSync(target)) {
    throw new Error(`archive did not produce ${target}`)
  }
  return target
}

/**
 * Install a managed AgentJail binary from an upstream release.
 *
 * The digest the manifest asserts is verified before anything is extracted, and
 * the binary is renamed into place only after extraction succeeds.
 * @param options - installer tuning.
 * @param facts - platform facts; defaults to the running platform.
 * @returns the install outcome; never throws for an expected failure.
 */
export async function installManagedBinary(
  options: InstallerOptions,
  facts: PlatformFacts = { platform: process.platform, arch: process.arch },
): Promise<InstallResult> {
  const version = options.version.length > 0 ? options.version : await resolveLatestVersion(options)
  if (version === undefined) {
    return { installed: false, reason: 'could not determine the latest AgentJail release' }
  }
  const asset = archiveName(facts, version)
  if (asset === undefined) {
    return {
      installed: false,
      reason: `no AgentJail release archive is published for ${facts.platform}/${facts.arch}`,
    }
  }

  const base = `${options.releaseBaseUrl}/${version}`
  let manifest: string
  try {
    manifest = new TextDecoder().decode(
      await fetchBytes(`${base}/SHA256SUMS`, options.timeoutMs, 1 << 20),
    )
  } catch (error) {
    return { installed: false, reason: describe(error, 'could not download SHA256SUMS') }
  }

  const expected = digestFromManifest(manifest, asset)
  if (expected === undefined) {
    return {
      installed: false,
      reason: `SHA256SUMS carries no digest for ${asset}; refusing to install unverified`,
    }
  }

  let archive: Uint8Array
  try {
    archive = await fetchBytes(`${base}/${asset}`, options.timeoutMs, options.maxArchiveBytes)
  } catch (error) {
    return { installed: false, reason: describe(error, `could not download ${asset}`) }
  }

  const actual = sha256(archive)
  if (actual !== expected) {
    return {
      installed: false,
      reason: `digest mismatch for ${asset}: expected ${expected}, got ${actual}`,
    }
  }

  const workdir = await mkdtemp(join(tmpdir(), 'agentjail-install-'))
  try {
    const archivePath = join(workdir, asset)
    await writeFile(archivePath, archive)
    let extracted: string
    try {
      extracted = await extractMember(archivePath, 'agentjail', workdir)
    } catch (error) {
      return { installed: false, reason: describe(error, 'could not extract the release archive') }
    }

    await mkdir(options.managedDir, { recursive: true, mode: 0o755 })
    const destination = join(options.managedDir, 'agentjail')
    const staging = `${destination}.partial`
    const bytes = await readFile(extracted)
    await writeFile(staging, bytes)
    await chmod(staging, 0o755)
    await rename(staging, destination)
    return { installed: true, path: destination, version }
  } catch (error) {
    return { installed: false, reason: describe(error, 'could not install the managed binary') }
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Resolve the newest published release tag.
 * @param options - installer tuning.
 * @returns the tag, or `undefined` when it could not be read.
 */
async function resolveLatestVersion(options: InstallerOptions): Promise<string | undefined> {
  const url = `${options.releaseBaseUrl}/latest/download/SHA256SUMS`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    })
    if (!response.ok) return undefined
    // The redirect target carries the tag: /releases/download/<tag>/...
    const final = response.url
    const match = /\/download\/([^/]+)\//.exec(final)
    return match?.[1]
  } catch {
    return undefined
  }
}

/** Describe an unknown error with context. */
function describe(error: unknown, prefix: string): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`
}
