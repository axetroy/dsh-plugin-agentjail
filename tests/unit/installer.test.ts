import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  archiveName,
  digestFromManifest,
  extractMember,
  installManagedBinary,
  sha256,
} from '../../src/adapter/installer.js'

const execFileAsync = promisify(execFile)

/**
 * Build a release-shaped archive: a top-level directory holding the binary,
 * which is how the upstream release tarballs are laid out.
 */
async function buildArchive(
  root: string,
  name: string,
  options: { nested: boolean; contents: string },
): Promise<Buffer> {
  const staging = join(root, `staging-${name}-${options.nested}`)
  const payloadDir = options.nested ? join(staging, 'agentjail-1.0.0') : staging
  await mkdir(payloadDir, { recursive: true })
  const binary = join(payloadDir, 'agentjail')
  await writeFile(binary, options.contents)
  await chmod(binary, 0o755)
  const archive = join(root, name)
  await execFileAsync('tar', [
    '-czf',
    archive,
    '-C',
    staging,
    options.nested ? 'agentjail-1.0.0' : 'agentjail',
  ])
  return readFile(archive)
}

interface Served {
  base: string
  close: () => Promise<void>
}

/** Serve a fixed set of paths from a real HTTP server, so fetch is exercised for real. */
async function serve(
  files: Map<string, Buffer | (() => { status: number; location: string })>,
): Promise<Served> {
  const server: Server = createServer((req, res) => {
    const entry = files.get(req.url ?? '')
    if (entry === undefined) {
      res.writeHead(404).end('not found')
      return
    }
    if (typeof entry === 'function') {
      const { status, location } = entry()
      res.writeHead(status, { location }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(entry)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

describe('release asset naming', () => {
  it('maps supported platforms and architectures', () => {
    expect(archiveName({ platform: 'linux', arch: 'x64' }, 'v1.8.2')).toBe(
      'agentjail-v1.8.2-linux-amd64.tar.gz',
    )
    expect(archiveName({ platform: 'darwin', arch: 'arm64' }, 'v1.8.2')).toBe(
      'agentjail-v1.8.2-darwin-arm64.tar.gz',
    )
  })

  it('refuses platforms with no published archive', () => {
    expect(archiveName({ platform: 'win32', arch: 'x64' }, 'v1.8.2')).toBeUndefined()
    expect(archiveName({ platform: 'linux', arch: 'ia32' }, 'v1.8.2')).toBeUndefined()
  })
})

describe('manifest parsing', () => {
  it('reads a digest for the named asset', () => {
    const digest = 'a'.repeat(64)
    const manifest = `${digest}  agentjail-v1.8.2-linux-amd64.tar.gz\n`
    expect(digestFromManifest(manifest, 'agentjail-v1.8.2-linux-amd64.tar.gz')).toBe(digest)
  })

  it('accepts binary-mode markers and uppercase digests', () => {
    const digest = 'A'.repeat(64)
    const manifest = `${digest} *agentjail.tar.gz\n`
    expect(digestFromManifest(manifest, 'agentjail.tar.gz')).toBe(digest.toLowerCase())
  })

  it('ignores comments, blanks, and short lines', () => {
    const manifest = '\n# comment\ndeadbeef  agentjail.tar.gz\n'
    expect(digestFromManifest(manifest, 'agentjail.tar.gz')).toBeUndefined()
  })

  it('returns undefined when the asset is absent', () => {
    expect(
      digestFromManifest(`${'b'.repeat(64)}  other.tar.gz\n`, 'agentjail.tar.gz'),
    ).toBeUndefined()
  })
})

describe('digest computation', () => {
  it('matches the known SHA-256 of an empty input', () => {
    expect(sha256(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('is stable across repeated calls', () => {
    const data = new TextEncoder().encode('agentjail')
    expect(sha256(data)).toBe(sha256(data))
  })
})

describe('archive extraction', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentjail-extract-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('extracts a binary nested under a directory', async () => {
    const archive = join(root, 'nested.tar.gz')
    await writeFile(
      archive,
      await buildArchive(root, 'nested.tar.gz', { nested: true, contents: 'nested' }),
    )
    const destination = await mkdtemp(join(root, 'out-nested-'))
    const extracted = await extractMember(archive, 'agentjail', destination)
    expect(await readFile(extracted, 'utf8')).toBe('nested')
  })

  it('extracts a binary at the archive root', async () => {
    const archive = join(root, 'flat.tar.gz')
    await writeFile(
      archive,
      await buildArchive(root, 'flat.tar.gz', { nested: false, contents: 'flat' }),
    )
    const destination = await mkdtemp(join(root, 'out-flat-'))
    const extracted = await extractMember(archive, 'agentjail', destination)
    expect(await readFile(extracted, 'utf8')).toBe('flat')
  })

  it('reports an archive that does not carry the member', async () => {
    const archive = join(root, 'empty.tar.gz')
    const staging = join(root, 'staging-empty')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'other'), 'x')
    await execFileAsync('tar', ['-czf', archive, '-C', staging, 'other'])
    await expect(
      extractMember(archive, 'agentjail', await mkdtemp(join(root, 'out-missing-'))),
    ).rejects.toThrow(/does not contain agentjail/)
  })
})

describe('managed install over HTTP', () => {
  let root: string
  let archive: Buffer
  let asset: string
  let digest: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentjail-install-'))
    asset = 'agentjail-v1.0.0-linux-amd64.tar.gz'
    archive = await buildArchive(root, asset, {
      nested: true,
      contents: '#!/bin/sh\necho managed\n',
    })
    digest = sha256(archive)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const facts = { platform: 'linux', arch: 'x64' }

  function optionsFor(base: string, managedDir: string) {
    return {
      version: 'v1.0.0',
      releaseBaseUrl: base,
      managedDir,
      timeoutMs: 5000,
      maxArchiveBytes: 32 * 1024 * 1024,
    }
  }

  it('installs a verified binary and makes it executable', async () => {
    const server = await serve(
      new Map([
        ['/v1.0.0/SHA256SUMS', Buffer.from(`${digest}  ${asset}\n`)],
        [`/v1.0.0/${asset}`, archive],
      ]),
    )
    const managedDir = join(root, 'managed-ok')
    try {
      const result = await installManagedBinary(optionsFor(server.base, managedDir), facts)
      expect(result.installed).toBe(true)
      expect(result.version).toBe('v1.0.0')
      expect(await readFile(join(managedDir, 'agentjail'), 'utf8')).toContain('echo managed')
    } finally {
      await server.close()
    }
  })

  it('refuses to install when the manifest has no entry for the asset', async () => {
    const server = await serve(
      new Map([
        ['/v1.0.0/SHA256SUMS', Buffer.from(`${digest}  something-else.tar.gz\n`)],
        [`/v1.0.0/${asset}`, archive],
      ]),
    )
    try {
      const result = await installManagedBinary(
        optionsFor(server.base, join(root, 'managed-noentry')),
        facts,
      )
      expect(result.installed).toBe(false)
      expect(result.reason).toContain('no digest')
    } finally {
      await server.close()
    }
  })

  it('refuses an archive whose bytes do not match the manifest', async () => {
    const tampered = Buffer.from(archive)
    tampered[0] = tampered[0]! ^ 0xff
    const server = await serve(
      new Map([
        ['/v1.0.0/SHA256SUMS', Buffer.from(`${digest}  ${asset}\n`)],
        [`/v1.0.0/${asset}`, tampered],
      ]),
    )
    try {
      const result = await installManagedBinary(
        optionsFor(server.base, join(root, 'managed-bad')),
        facts,
      )
      expect(result.installed).toBe(false)
      expect(result.reason).toContain('digest mismatch')
    } finally {
      await server.close()
    }
  })

  it('reports an unreachable manifest without throwing', async () => {
    const server = await serve(new Map())
    try {
      const result = await installManagedBinary(
        optionsFor(server.base, join(root, 'managed-404')),
        facts,
      )
      expect(result.installed).toBe(false)
      expect(result.reason).toContain('SHA256SUMS')
    } finally {
      await server.close()
    }
  })

  it('reports an unsupported platform without any request', async () => {
    const result = await installManagedBinary(
      optionsFor('http://127.0.0.1:1', join(root, 'managed-unsupported')),
      { platform: 'win32', arch: 'x64' },
    )
    expect(result.installed).toBe(false)
    expect(result.reason).toContain('no AgentJail release archive')
  })

  it('resolves the latest tag from the release redirect', async () => {
    // The redirect target is built from the request's Host header, so the test
    // server does not need to know its own port in advance.
    const redirecting = createServer((req, res) => {
      const host = req.headers.host ?? '127.0.0.1'
      if (req.url === '/latest/download/SHA256SUMS') {
        // GitHub redirects to a path carrying the tag, which is where the
        // version is read from.
        res.writeHead(302, { location: `http://${host}/download/v1.0.0/SHA256SUMS` }).end()
        return
      }
      if (req.url === '/download/v1.0.0/SHA256SUMS' || req.url === '/v1.0.0/SHA256SUMS') {
        res.writeHead(200).end(`${digest}  ${asset}\n`)
        return
      }
      if (req.url === `/v1.0.0/${asset}`) {
        res.writeHead(200).end(archive)
        return
      }
      res.writeHead(404).end('not found')
    })
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
    const address = redirecting.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const managedDir = join(root, 'managed-latest')
    try {
      const result = await installManagedBinary(
        { ...optionsFor(`http://127.0.0.1:${port}`, managedDir), version: '' },
        facts,
      )
      expect(result.installed).toBe(true)
      expect(result.version).toBe('v1.0.0')
    } finally {
      redirecting.closeAllConnections?.()
      await new Promise<void>((resolve) => redirecting.close(() => resolve()))
    }
  })
})
