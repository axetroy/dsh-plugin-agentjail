/**
 * The daemon's privileged control plane.
 *
 * Upstream serves policy reload on a second socket, not the one hooks use, and
 * gates it with a token the daemon mints at startup. The split is deliberate: the
 * agent-facing socket must stay reachable for hooks to work at all, and reload is
 * a full Rego recompile, so serving it there would hand any reachable process a
 * cheap way to make the daemon expensive.
 *
 * The practical consequence for this plugin is that `reloadPolicy` cannot use the
 * client's pooled agent socket. It has to open the control socket and present the
 * token. When that is not possible - no token, no control socket, or a daemon
 * that refuses - the caller degrades to restarting a daemon it manages rather
 * than reporting a success that did not happen.
 * @module dsh-plugin-agentjail/adapter/control
 */

import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineDecoder, decodeFrame } from './protocol.js'
import { DaemonUnavailableError, describeUnknown, PolicyTimeoutError } from '../utils/errors.js'

/** Control operation asking the daemon to reload policy in place. */
export const CONTROL_OP_DAEMON_RELOAD = 'daemon_reload'

/** Result of a control-plane request. */
export interface ControlPlaneResult {
  /** Whether the daemon accepted and completed the operation. */
  ok: boolean
  /** The daemon's refusal reason, when it refused. */
  error?: string
}

/** Where the control plane lives for a given daemon. */
export interface ControlPlanePaths {
  /** The privileged control socket. */
  socketPath: string
  /** The control token file the daemon wrote. */
  tokenPath: string
}

/**
 * Resolve the control-plane paths for a daemon running under a given `HOME`.
 *
 * Upstream derives both paths from `HOME`, so a plugin-managed daemon with a
 * private `HOME` has its control plane under that `HOME`, while an operator's own
 * daemon has it under the real one. Passing the right `HOME` is what keeps the
 * two apart.
 * @param home - the daemon's `HOME`.
 * @returns the control socket and token paths.
 */
export function controlPlanePaths(home: string): ControlPlanePaths {
  const state = join(home, '.agentjail')
  return {
    socketPath: join(state, 'run', 'daemon-ctl.sock'),
    tokenPath: join(state, 'control.token'),
  }
}

/** The control-plane paths for a daemon running under the process's own `HOME`. */
export function defaultControlPlanePaths(env: NodeJS.ProcessEnv = process.env): ControlPlanePaths {
  const home = env['HOME']
  if (home === undefined || home.length === 0) {
    throw new DaemonUnavailableError('HOME is not set, so the control plane cannot be located')
  }
  return controlPlanePaths(home)
}

/**
 * Read the daemon's control token.
 * @param tokenPath - path to the token file.
 * @returns the trimmed token, or `undefined` when it is missing or empty.
 */
export function readControlToken(tokenPath: string): string | undefined {
  try {
    const token = readFileSync(tokenPath, 'utf8').trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask a daemon to reload its policy over the privileged control socket.
 *
 * Every failure is returned rather than thrown, because a caller that cannot
 * reload has a legitimate fallback (restart the daemon it manages) and needs to
 * distinguish "the daemon said no" from "the control plane is unreachable".
 * @param paths - the control-plane paths.
 * @param timeoutMs - response budget in milliseconds.
 * @returns the outcome; `ok` is false with a reason when reload did not happen.
 */
export async function reloadViaControlPlane(
  paths: ControlPlanePaths,
  timeoutMs: number,
): Promise<ControlPlaneResult> {
  const token = readControlToken(paths.tokenPath)
  if (token === undefined) {
    return {
      ok: false,
      error: `no control token at ${paths.tokenPath}; reload requires the daemon's privileged control plane`,
    }
  }
  try {
    const frame = await sendControlFrame(
      paths.socketPath,
      { type: CONTROL_OP_DAEMON_RELOAD, ctl_token: token },
      timeoutMs,
    )
    const ok = frame['ok']
    if (typeof ok !== 'boolean') {
      return { ok: false, error: 'control plane returned no boolean "ok" field' }
    }
    if (ok) return { ok: true }
    const error = frame['error']
    return {
      ok: false,
      error: typeof error === 'string' ? error : 'control plane refused the reload',
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Open one control-socket round trip. */
function sendControlFrame(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const decoder = new LineDecoder()
    const socket = createConnection(socketPath)
    let settled = false
    const finish = (error: unknown, value?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (!socket.destroyed) socket.destroy()
      if (error !== undefined)
        reject(error instanceof Error ? error : new Error(describeUnknown(error)))
      else resolve(value ?? {})
    }
    const onData = (chunk: Buffer): void => {
      const [first] = decoder.push(chunk.toString('utf8'))
      if (first === undefined) return
      try {
        finish(undefined, decodeFrame(first))
      } catch (error) {
        finish(error)
      }
    }
    const onError = (error: Error): void =>
      finish(new DaemonUnavailableError(`control plane at ${socketPath}: ${error.message}`))
    const onClose = (): void =>
      finish(new DaemonUnavailableError('control plane closed the connection before replying'))
    const timer = setTimeout(
      () => finish(new PolicyTimeoutError(timeoutMs)),
      Math.max(timeoutMs, 1),
    )

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.once('connect', () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        finish(error)
      }
    })
  })
}
