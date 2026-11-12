/**
 * Unix-socket transport to the AgentJail daemon.
 *
 * The daemon serves a persistent, newline-delimited JSON connection: it scans
 * one request per line and writes one response line back before reading again.
 * This class owns connecting, framing, per-request timeouts, reconnect backoff,
 * and liveness probes.
 *
 * Failures are surfaced, never swallowed: the caller decides whether an
 * unreachable daemon means deny or ask, and that decision belongs to the
 * configuration rather than to the transport.
 * @module dsh-plugin-agentjail/adapter/connection
 */

import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_OP_PING,
  CONTROL_TYPE,
  LineDecoder,
  decodeFrame,
  encodeRequest,
  toControlResult,
  toPolicyDecision,
  type ControlRequest,
  type ControlResult,
  type PolicyDecision,
  type PolicyRequestFrame,
} from './protocol.js'
import {
  DaemonUnavailableError,
  PolicyTimeoutError,
  ProtocolError,
  RequestTooLargeError,
} from '../utils/errors.js'

/** Connection tuning, all sourced from plugin configuration. */
export interface ConnectionOptions {
  /** Absolute socket path; empty resolves the daemon default. */
  socketPath: string
  /** Per-request response budget in milliseconds. */
  timeoutMs: number
  /** First reconnect delay in milliseconds. */
  reconnectDelayMs: number
  /** Maximum reconnect backoff in milliseconds. */
  maxReconnectDelayMs: number
  /** Maximum encoded request size in bytes. */
  maxRequestBytes: number
}

/** Outcome of one request that either produced a response line or failed. */
type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Resolve the daemon socket path.
 *
 * Precedence is explicit configuration, then `AGENTJAIL_SOCKET`, then the
 * per-user default. The environment variable exists so a container or a test
 * harness can redirect the socket without editing a config file.
 * @param configured - the configured path, or an empty string for the default.
 * @returns the absolute socket path.
 */
export function resolveSocketPath(configured: string): string {
  if (configured.length > 0) return configured
  const fromEnvironment = process.env['AGENTJAIL_SOCKET']
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment
  const home = process.env['HOME'] ?? homedir()
  return join(home, '.agentjail', 'daemon.sock')
}

/**
 * A single long-lived connection to the AgentJail daemon.
 *
 * Requests are serialized: the daemon replies in order on one connection, so
 * one in-flight request at a time keeps responses matched to requests without a
 * correlation table. A failed connection is discarded and rebuilt on demand.
 */
export class AgentJailConnection {
  private socket: Socket | undefined
  private decoder = new LineDecoder()
  private queue: Promise<unknown> = Promise.resolve()
  private connecting: Promise<Socket> | undefined
  private consecutiveFailures = 0
  private closed = false

  /** The resolved socket path, exposed for diagnostics. */
  readonly socketPath: string

  constructor(private readonly options: ConnectionOptions) {
    this.socketPath = resolveSocketPath(options.socketPath)
  }

  /**
   * Evaluate one tool call against the daemon's policy engine.
   * @param frame - the request frame to send.
   * @param signal - caller cancellation; aborts the wait without closing the socket.
   * @returns the validated policy decision.
   */
  async evaluate(frame: PolicyRequestFrame, signal?: AbortSignal): Promise<PolicyDecision> {
    const raw = await this.request(frame, signal)
    return toPolicyDecision(raw)
  }

  /**
   * Probe the daemon with the side-effect-free `control/ping` operation.
   * @param signal - caller cancellation.
   * @returns the control result; `ok` is false when the daemon rejected the probe.
   */
  async ping(signal?: AbortSignal): Promise<ControlResult> {
    const frame: ControlRequest = { type: CONTROL_TYPE, op: CONTROL_OP_PING }
    const raw = await this.request(frame, signal)
    return toControlResult(raw)
  }

  /**
   * Send one frame and await its response line.
   *
   * Requests are chained so a second caller waits for the first response rather
   * than interleaving on the shared socket.
   * @param frame - the frame to encode and send.
   * @param signal - caller cancellation.
   * @returns the decoded response frame.
   */
  private request(
    frame: PolicyRequestFrame | ControlRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      if (this.closed) throw new DaemonUnavailableError('AgentJail connection is closed')
      if (signal?.aborted === true) throw toAbortError(signal)
      const line = encodeRequest(frame, this.options.maxRequestBytes)
      const attempt = await this.attempt(line, signal)
      if (!attempt.ok) throw attempt.error
      return attempt.value
    }
    const chained = this.queue.then(run, run)
    this.queue = chained.catch(() => undefined)
    return chained
  }

  /** Run one connect-write-read cycle, discarding the socket on any failure. */
  private async attempt(
    line: string,
    signal?: AbortSignal,
  ): Promise<AttemptResult<Record<string, unknown>>> {
    let socket: Socket
    try {
      socket = await this.acquire()
    } catch (error) {
      this.noteFailure()
      return { ok: false, error: toUnavailable(error) }
    }

    try {
      const response = await this.roundTrip(socket, line, signal)
      this.consecutiveFailures = 0
      return { ok: true, value: response }
    } catch (error) {
      this.discard(socket)
      this.noteFailure()
      return { ok: false, error }
    }
  }

  /** Write one request line and read exactly one response line. */
  private roundTrip(
    socket: Socket,
    line: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined)
          reject(error instanceof Error ? error : new Error(describeUnknown(error)))
        else resolve(value ?? {})
      }
      const onData = (chunk: Buffer): void => {
        let lines: string[]
        try {
          lines = this.decoder.push(chunk.toString('utf8'))
        } catch (error) {
          finish(error)
          return
        }
        const [first] = lines
        if (first === undefined) return
        try {
          finish(undefined, decodeFrame(first))
        } catch (error) {
          finish(error)
        }
      }
      const onError = (error: Error): void => finish(toUnavailable(error))
      const onClose = (): void =>
        finish(new DaemonUnavailableError('AgentJail daemon closed the connection before replying'))
      const onAbort = (): void => finish(toAbortError(signal))
      const timer = setTimeout(
        () => finish(new PolicyTimeoutError(this.options.timeoutMs)),
        this.options.timeoutMs,
      )

      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        socket.write(line)
      } catch (error) {
        finish(toUnavailable(error))
      }
    })
  }

  /** Return a connected socket, establishing one if necessary. */
  private async acquire(): Promise<Socket> {
    const existing = this.socket
    if (existing !== undefined && !existing.destroyed) return existing
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined
    })
    const socket = await this.connecting
    this.socket = socket
    return socket
  }

  /** Open a socket and attach the one-shot teardown handlers. */
  private connect(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      this.decoder.reset()
      const onConnect = (): void => {
        socket.off('error', onError)
        socket.on('error', () => this.discard(socket))
        socket.on('close', () => this.discard(socket))
        resolve(socket)
      }
      const onError = (error: Error): void => {
        socket.off('connect', onConnect)
        socket.destroy()
        reject(
          new DaemonUnavailableError(
            `cannot connect to AgentJail daemon at ${this.socketPath}: ${error.message}`,
            { cause: error },
          ),
        )
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  /** Drop a socket from the pool without disturbing a newer one. */
  private discard(socket: Socket): void {
    if (this.socket === socket) this.socket = undefined
    this.decoder.reset()
    if (!socket.destroyed) socket.destroy()
  }

  /** Track failures so the backoff can grow. */
  private noteFailure(): void {
    this.consecutiveFailures += 1
  }

  /**
   * Delay before the next reconnect attempt, honoring exponential backoff.
   * @returns milliseconds to wait; `0` after a healthy request.
   */
  backoffMs(): number {
    if (this.consecutiveFailures === 0) return 0
    const base = Math.max(this.options.reconnectDelayMs, 0)
    const cap = Math.max(this.options.maxReconnectDelayMs, base)
    return Math.min(base * 2 ** (this.consecutiveFailures - 1), cap)
  }

  /** Number of consecutive failed requests since the last success. */
  get failures(): number {
    return this.consecutiveFailures
  }

  /** Whether a live socket is currently pooled. */
  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed
  }

  /** Close the pooled socket and reject subsequent requests. */
  close(): void {
    this.closed = true
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined && !socket.destroyed) socket.destroy()
  }
}

/** Convert any thrown value into the daemon-unavailable class, preserving known errors. */
function toUnavailable(error: unknown): Error {
  if (error instanceof DaemonUnavailableError) return error
  if (
    error instanceof PolicyTimeoutError ||
    error instanceof ProtocolError ||
    error instanceof RequestTooLargeError
  ) {
    return error
  }
  if (error instanceof Error) return new DaemonUnavailableError(error.message, { cause: error })
  return new DaemonUnavailableError(describeUnknown(error), { cause: error })
}

/** Describe an arbitrary thrown value without relying on default stringification. */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'unknown transport failure'
  } catch {
    return 'unknown transport failure'
  }
}

/** Build the canonical abort error for a cancelled wait. */
function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('AgentJail policy evaluation aborted by the caller')
  error.name = 'AbortError'
  return error
}
