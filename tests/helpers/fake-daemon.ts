/**
 * A real Unix-socket AgentJail daemon stand-in.
 *
 * The adapter tests exercise the actual wire contract: a real `net.Server` on a
 * real socket path, real newline-delimited JSON framing, real timeouts. Faking
 * the socket module would test the mock instead of the protocol, which is the
 * part most likely to drift from the daemon.
 * @module tests/helpers/fake-daemon
 */

import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A scripted reply for one request. */
export type Reply =
  | { kind: 'json'; body: Record<string, unknown> }
  | { kind: 'raw'; body: string }
  | { kind: 'silence' }
  | { kind: 'hangup' }
  | { kind: 'delay'; ms: number; body: Record<string, unknown> }

/** A request the fake daemon received, decoded from its wire line. */
export interface ReceivedRequest {
  line: string
  frame: Record<string, unknown>
}

/**
 * A scripted AgentJail daemon on a real Unix socket.
 *
 * Replies are consumed in order; the last one repeats, so a test can script a
 * sequence and then let a steady-state reply serve the remainder.
 */
export class FakeDaemon {
  private server: Server | undefined
  private directory: string | undefined
  private readonly replies: Reply[] = []
  private readonly received: ReceivedRequest[] = []
  private readonly connections = new Set<Socket>()
  private defaultReply: Reply = { kind: 'json', body: { action: 'allow' } }
  private controlReply: Reply = { kind: 'json', body: { ok: true, version: 'test' } }

  /** Absolute path the daemon is listening on, available after {@link listen}. */
  socketPath = ''

  /**
   * Queue replies, consumed in order.
   * @param replies - replies to append.
   * @returns this daemon, for chaining.
   */
  enqueue(...replies: Reply[]): this {
    this.replies.push(...replies)
    return this
  }

  /**
   * Set the reply used once the queue drains.
   * @param reply - the steady-state reply.
   * @returns this daemon, for chaining.
   */
  always(reply: Reply): this {
    this.defaultReply = reply
    return this
  }

  /**
   * Set the reply used for control-plane (`type: "control"`) requests.
   *
   * The real daemon routes control frames before policy frames, so the fake one
   * does too: a control ping is answered with a control response and never
   * consumes a scripted policy reply.
   * @param reply - the control reply.
   * @returns this daemon, for chaining.
   */
  control(reply: Reply): this {
    this.controlReply = reply
    return this
  }

  /**
   * Start listening on a fresh socket path under a temporary directory.
   * @returns the absolute socket path.
   */
  async listen(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), 'agentjail-fake-'))
    this.socketPath = join(this.directory, 'daemon.sock')
    const server = createServer((socket) => this.handle(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    return this.socketPath
  }

  /** Serve one connection: decode lines, reply per script. */
  private handle(socket: Socket): void {
    this.connections.add(socket)
    socket.on('close', () => this.connections.delete(socket))
    socket.on('error', () => this.connections.delete(socket))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim().length === 0) continue
        const frame = JSON.parse(line) as Record<string, unknown>
        this.received.push({ line, frame })
        void this.reply(socket, frame)
      }
    })
  }

  /** Write the next scripted reply, routing control frames like the daemon. */
  private async reply(socket: Socket, frame: Record<string, unknown>): Promise<void> {
    const reply =
      frame['type'] === 'control' ? this.controlReply : (this.replies.shift() ?? this.defaultReply)
    switch (reply.kind) {
      case 'json':
        socket.write(`${JSON.stringify(reply.body)}\n`)
        return
      case 'raw':
        socket.write(reply.body)
        return
      case 'silence':
        return
      case 'hangup':
        socket.destroy()
        return
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, reply.ms))
        if (!socket.destroyed) socket.write(`${JSON.stringify(reply.body)}\n`)
        return
    }
  }

  /** Every request the daemon received, in order. */
  get requests(): readonly ReceivedRequest[] {
    return this.received
  }

  /** The most recent request, or `undefined` when none arrived. */
  get lastRequest(): ReceivedRequest | undefined {
    return this.received[this.received.length - 1]
  }

  /**
   * Policy-evaluation requests, excluding control-plane frames.
   *
   * Health probes share the socket with policy evaluations, so a test that
   * counts policy round trips must filter them out.
   */
  get policyRequests(): readonly ReceivedRequest[] {
    return this.received.filter((request) => request.frame['type'] !== 'control')
  }

  /** The number of open connections. */
  get openConnections(): number {
    return this.connections.size
  }

  /** Stop listening and remove the temporary socket directory. */
  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    const directory = this.directory
    this.directory = undefined
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
}

/**
 * A daemon that accepts connections and never replies.
 *
 * Used to prove a timeout is enforced rather than waiting forever.
 */
export class SilentDaemon extends FakeDaemon {
  constructor() {
    super()
    this.always({ kind: 'silence' })
  }
}

/** A socket path that is guaranteed to have no listener. */
export async function unusedSocketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentjail-unused-'))
  return join(directory, 'absent.sock')
}
