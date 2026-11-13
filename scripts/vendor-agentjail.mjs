#!/usr/bin/env node
/**
 * Vendor the pinned AgentJail build into `vendor/<platform>-<arch>/`.
 *
 * The plugin ships the AgentJail build it was tested against, so installing the
 * plugin is enough to get a working engine. This script is what puts that build
 * in the package, and it is run by hand or by CI - never at install time, and
 * never by the plugin itself.
 *
 * The order of operations is the point: the archive is hashed and compared
 * against `vendor.lock.json` *before* anything is unpacked, and only the two
 * executables plus the licence files are copied out. A tampered or truncated
 * download never reaches the filesystem as a runnable file.
 *
 * Usage:
 *   node scripts/vendor-agentjail.mjs                 # current platform
 *   node scripts/vendor-agentjail.mjs --all           # every locked target
 *   node scripts/vendor-agentjail.mjs --target linux-arm64
 *   node scripts/vendor-agentjail.mjs --check         # verify what is present
 * @module scripts/vendor-agentjail
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, copyFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(packageRoot, 'vendor.lock.json')
const vendorRoot = join(packageRoot, 'vendor')

/** Files copied out of an archive into the vendored directory. */
const VENDORED_FILES = ['agentjail', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES']

/** Map a Node platform/arch pair onto a locked target label. */
function targetLabel(platform, arch) {
  const aliases = { x64: 'amd64', arm64: 'arm64' }
  const mapped = aliases[arch]
  if (mapped === undefined) return undefined
  return `${platform}-${mapped}`
}

/** Parse argv into options. */
function parseArguments(argv) {
  const options = { all: false, check: false, target: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--all') options.all = true
    else if (argument === '--check') options.check = true
    else if (argument === '--target') {
      index += 1
      options.target = argv[index]
    } else if (argument?.startsWith('--target=')) {
      options.target = argument.slice('--target='.length)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

/** Compute a file's SHA-256 digest as lowercase hex. */
async function sha256File(path) {
  const digest = createHash('sha256')
  digest.update(await readFile(path))
  return digest.digest('hex')
}

/** Download a URL to a file, following redirects. */
async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

/** Extract an archive into a directory using the system `tar`. */
function extractArchive(archivePath, destination) {
  execFileSync('tar', ['-xzf', archivePath, '-C', destination], { stdio: 'inherit' })
}

/** Vendor one locked target. */
async function vendorTarget(lock, label) {
  const target = lock.targets[label]
  if (target === undefined) throw new Error(`no locked target named ${label}`)
  const url = `${lock.releaseBaseUrl}/${lock.version}/${target.asset}`
  const destination = join(vendorRoot, label)

  process.stdout.write(`vendoring ${label} from ${url}\n`)
  const scratch = await mkdtemp(join(tmpdir(), 'agentjail-vendor-'))
  try {
    const archive = join(scratch, target.asset)
    await download(url, archive)

    const digest = await sha256File(archive)
    if (digest !== target.sha256) {
      throw new Error(
        `checksum mismatch for ${target.asset}\n  expected ${target.sha256}\n  actual   ${digest}`,
      )
    }

    const unpacked = join(scratch, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    extractArchive(archive, unpacked)

    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    for (const name of VENDORED_FILES) {
      const source = join(unpacked, name)
      try {
        await stat(source)
      } catch {
        continue
      }
      await copyFile(source, join(destination, name))
    }
    await chmod(join(destination, 'agentjail'), 0o755)
    process.stdout.write(`vendored ${label} (sha256 ${digest.slice(0, 12)}...)\n`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Verify that a vendored target is present and executable. */
async function checkTarget(label) {
  const binary = join(vendorRoot, label, 'agentjail')
  try {
    const info = await stat(binary)
    process.stdout.write(`${label}: present (${info.size} bytes)\n`)
    return true
  } catch {
    process.stdout.write(`${label}: missing\n`)
    return false
  }
}

/** Entry point. */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))

  if (options.check) {
    // Default to the running platform, matching what a bare `vendor` fetches, so
    // `vendor && vendor:check` is a consistent pair. `--all` checks every target.
    const labels =
      options.target !== undefined
        ? [options.target]
        : options.all
          ? Object.keys(lock.targets)
          : [targetLabel(process.platform, process.arch)]
    let ok = true
    for (const label of labels) {
      if (label === undefined) {
        process.stdout.write(`${process.platform}-${process.arch}: no locked target\n`)
        ok = false
        continue
      }
      ok = (await checkTarget(label)) && ok
    }
    process.exitCode = ok ? 0 : 1
    return
  }

  const labels =
    options.target !== undefined
      ? [options.target]
      : options.all
        ? Object.keys(lock.targets)
        : [targetLabel(process.platform, process.arch)]

  if (labels[0] === undefined) {
    throw new Error(`no vendored build is defined for ${process.platform}-${process.arch}`)
  }
  for (const label of labels) await vendorTarget(lock, label)
}

await main()
