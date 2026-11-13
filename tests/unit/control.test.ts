/**
 * Control-plane tests against a real Unix socket.
 *
 * Reload is the one privileged operation the plugin performs, so these exercise
 * the real transport: a real `net.Server`, a real token file, real framing. The
 * case that matters most is the refusal path - a daemon that says no, or a
 * control plane that cannot be reached, must never be reported as a reload.
 * @module tests/unit/control
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_OP_DAEMON_RELOAD,
  controlPlanePaths,
  defaultControlPlanePaths,
  readControlToken,
  reloadViaControlPlane,
} from '../../src/adapter/control.js'

/** A control socket that replies with one scripted frame. */
class FakeControlPlane {
  private server: Server | undefined
  private directory: string | undefined
  socketPath = ''
  tokenPath = ''
  /** Requests received, decoded from their wire lines. */
  readonly received: Array<Record<string, unknown>> = []
  private reply = '{"ok":true}\n'
  private token: string | undefined = 'test-token'

  /** Start listening on a temporary socket. */
  async listen(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'agentjail-control-'))
    const home = join(this.directory, 'home')
    const paths = controlPlanePaths(home)
    await mkdir(join(home, '.agentjail', 'run'), { recursive: true })
    this.socketPath = paths.socketPath
    this.tokenPath = paths.tokenPath
    if (this.token !== undefined) await writeFile(this.tokenPath, `${this.token}\n`)

    this.server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        this.received.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
        socket.end(this.reply)
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(this.socketPath, resolve))
  }

  /** Set the frame the control plane replies with. */
  answer(frame: Record<string, unknown>): this {
    this.reply = `${JSON.stringify(frame)}\n`
    return this
  }

  /** Reply with raw, unparseable bytes. */
  answerRaw(text: string): this {
    this.reply = text
    return this
  }

  /** Remove the token file, as an operator's daemon with no control plane would. */
  async removeToken(): Promise<void> {
    this.token = undefined
    await chmod(this.tokenPath, 0o000).catch(() => undefined)
  }

  /** Stop listening. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) return resolve()
      this.server.close(() => resolve())
    })
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function controlPlane(): Promise<FakeControlPlane> {
  const plane = new FakeControlPlane()
  await plane.listen()
  cleanups.push(() => plane.close())
  return plane
}

describe('controlPlanePaths', () => {
  it('derives the control socket and token from HOME', () => {
    expect(controlPlanePaths('/home/tester')).toEqual({
      socketPath: '/home/tester/.agentjail/run/daemon-ctl.sock',
      tokenPath: '/home/tester/.agentjail/control.token',
    })
  })

  it('uses the process HOME by default', () => {
    expect(defaultControlPlanePaths({ HOME: '/home/tester' })).toEqual(
      controlPlanePaths('/home/tester'),
    )
  })

  it('reports a missing HOME rather than guessing a path', () => {
    expect(() => defaultControlPlanePaths({})).toThrow(/HOME is not set/)
  })
})

describe('readControlToken', () => {
  it('reads and trims the token', async () => {
    const plane = await controlPlane()
    expect(readControlToken(plane.tokenPath)).toBe('test-token')
  })

  it('returns undefined when the token is absent or empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentjail-token-'))
    expect(readControlToken(join(directory, 'absent'))).toBeUndefined()
    const empty = join(directory, 'empty')
    await writeFile(empty, '\n  \n')
    expect(readControlToken(empty)).toBeUndefined()
  })
})

describe('reloadViaControlPlane', () => {
  it('sends the reload verb with the control token and reports success', async () => {
    const plane = await controlPlane()
    const result = await reloadViaControlPlane(plane, 2000)
    expect(result).toEqual({ ok: true })
    expect(plane.received[0]).toEqual({
      type: CONTROL_OP_DAEMON_RELOAD,
      ctl_token: 'test-token',
    })
  })

  it('reports the daemon refusal reason', async () => {
    const plane = await controlPlane()
    plane.answer({ ok: false, error: 'reload failed' })
    expect(await reloadViaControlPlane(plane, 2000)).toEqual({ ok: false, error: 'reload failed' })
  })

  it('reports a refusal without a reason', async () => {
    const plane = await controlPlane()
    plane.answer({ ok: false })
    expect(await reloadViaControlPlane(plane, 2000)).toEqual({
      ok: false,
      error: 'control plane refused the reload',
    })
  })

  it('reports a reply with no boolean ok field', async () => {
    const plane = await controlPlane()
    plane.answer({ status: 'done' })
    expect(await reloadViaControlPlane(plane, 2000)).toEqual({
      ok: false,
      error: 'control plane returned no boolean "ok" field',
    })
  })

  it('refuses to send anything when no token is readable', async () => {
    const plane = await controlPlane()
    await plane.removeToken()
    const result = await reloadViaControlPlane(plane, 2000)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no control token')
    // The refusal happened before the socket was used, so no request was sent.
    expect(plane.received).toHaveLength(0)
  })

  it('reports an unreachable control socket rather than throwing', async () => {
    const result = await reloadViaControlPlane(
      { socketPath: '/tmp/agentjail-absent-control.sock', tokenPath: '/tmp/absent-token' },
      2000,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no control token')
  })

  it('reports a timeout when the daemon never answers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentjail-hang-'))
    const paths = controlPlanePaths(directory)
    await mkdir(join(directory, '.agentjail', 'run'), { recursive: true })
    await writeFile(paths.tokenPath, 'token\n')
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      // Accept the connection and never reply.
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(paths.socketPath, resolve))
    // `close` waits for open connections, and the point of this server is to hold
    // one open, so connections are destroyed explicitly before closing.
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const result = await reloadViaControlPlane(paths, 50)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exceeded')
  })

  it('reports an unparseable reply rather than reporting success', async () => {
    const plane = await controlPlane()
    plane.answerRaw('not json\n')
    const result = await reloadViaControlPlane(plane, 2000)
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('reports a connection closed before a reply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentjail-close-'))
    const paths = controlPlanePaths(directory)
    await mkdir(join(directory, '.agentjail', 'run'), { recursive: true })
    await writeFile(paths.tokenPath, 'token\n')
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.end()
    })
    await new Promise<void>((resolve) => server.listen(paths.socketPath, resolve))
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const result = await reloadViaControlPlane(paths, 2000)
    expect(result.ok).toBe(false)
  })
})
