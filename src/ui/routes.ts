/**
 * Panel data routes.
 *
 * The AgentJail panel is a settings section contributed by the plugin's browser
 * half, so this module serves data only: the JSON the section reads, and a text
 * rendering for an operator who has no browser. The section is injected through
 * the client slot system, not served as a page from here.
 *
 * The routes are registered only when a Harness web server is composed. A
 * headless deployment, the CLI, or the desktop app may not have one, so absence
 * is not an error, and the plugin's enforcement path does not depend on any of
 * this.
 *
 * Both routes are read-only. Nothing here can widen a policy, clear a denial, or
 * turn the plugin's failure posture into an allow.
 * @module dsh-plugin-agentjail/ui/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dashboardPayload, renderDashboardText } from './dashboard.js'
import type { DashboardData } from './dashboard.js'

/** The subset of the Harness web server this module uses. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Options for {@link registerDashboardRoutes}. */
export interface DashboardRouteOptions {
  /** Base path, without a trailing slash. */
  basePath: string
  /** Supplies the data for one render. */
  collect: () => DashboardData
  /** Maximum audit records returned by the JSON endpoint. */
  recordLimit: number
}

/** Write a complete response and end it. */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

/** Answer with a JSON error document. */
function sendError(res: ServerResponse, error: unknown): void {
  send(
    res,
    500,
    'application/json; charset=utf-8',
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
  )
}

/**
 * Decide whether the caller asked for JSON or plain text.
 *
 * `curl` sends a wildcard Accept header, so anything that is not explicitly
 * JSON gets text. That makes `curl http://host/agentjail` readable without a
 * flag, which is the common case for an operator checking on a box. The rich
 * view is the settings section in the Harness UI, not a page served here.
 * @param req - the incoming request.
 * @param override - an explicit `?format=` value, when present.
 * @returns the response format.
 */
export function negotiateFormat(req: IncomingMessage, override?: string | null): 'text' | 'json' {
  if (override === 'json') return 'json'
  if (override === 'text') return 'text'
  const accept = String(req.headers['accept'] ?? '')
  if (accept.includes('application/json')) return 'json'
  return 'text'
}

/**
 * Register the dashboard data routes.
 *
 * Each `register` call returns a disposer, and the returned function calls them
 * all, so unloading the plugin removes every route it added.
 * @param server - the Harness web server.
 * @param options - route configuration.
 * @returns a disposer removing every registered route.
 */
export function registerDashboardRoutes(
  server: WebServerLike,
  options: DashboardRouteOptions,
): () => void {
  const { basePath } = options
  const disposers: Array<() => void> = []

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${basePath}/api/summary`,
      handler: (_req, res) => {
        try {
          send(
            res,
            200,
            'application/json; charset=utf-8',
            JSON.stringify(dashboardPayload(options.collect()), null, 2),
          )
        } catch (error) {
          sendError(res, error)
        }
      },
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${basePath}/api/decisions`,
      handler: (req, res) => {
        const url = new URL(req.url ?? basePath, 'http://localhost')
        const limit = clampLimit(url.searchParams.get('limit'), options.recordLimit)
        const verdict = url.searchParams.get('verdict')
        try {
          const data = options.collect()
          const records = data.records
            .filter((record) => verdict === null || record.verdict === verdict)
            .slice(0, limit)
          send(
            res,
            200,
            'application/json; charset=utf-8',
            JSON.stringify({ count: records.length, records }, null, 2),
          )
        } catch (error) {
          sendError(res, error)
        }
      },
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: `${basePath}/api/health`,
      handler: (_req, res) => {
        try {
          const data = options.collect()
          send(
            res,
            200,
            'application/json; charset=utf-8',
            JSON.stringify(
              {
                state: data.health.state,
                socketPath: data.health.socketPath,
                connected: data.health.connected,
                consecutiveFailures: data.health.consecutiveFailures,
                lastError: data.health.lastError,
                daemonVersion: data.health.daemonVersion,
                supervision: data.supervision,
                enforcement: data.enforcement,
                failureAction: data.failureAction,
              },
              null,
              2,
            ),
          )
        } catch (error) {
          sendError(res, error)
        }
      },
    }),
  )

  disposers.push(
    server.register({
      kind: 'exact',
      path: basePath,
      handler: (req, res) => {
        const url = new URL(req.url ?? basePath, 'http://localhost')
        const format = negotiateFormat(req, url.searchParams.get('format'))
        let data: DashboardData
        try {
          data = options.collect()
        } catch (error) {
          send(
            res,
            500,
            'text/plain; charset=utf-8',
            `agentjail dashboard could not collect data: ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }
        if (format === 'json') {
          send(
            res,
            200,
            'application/json; charset=utf-8',
            JSON.stringify(dashboardPayload(data), null, 2),
          )
          return
        }
        send(res, 200, 'text/plain; charset=utf-8', renderDashboardText(data))
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A route already removed by the server's own teardown is not an error.
      }
    }
  }
}

/**
 * Clamp a `limit` query parameter into a usable range.
 * @param raw - the raw parameter, or null when absent.
 * @param fallback - the value to use when the parameter is absent or unparsable.
 * @returns a limit between 1 and 1000.
 */
export function clampLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw.length === 0) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 1), 1000)
}
