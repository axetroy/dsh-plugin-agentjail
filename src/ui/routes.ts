/**
 * Dashboard HTTP routes.
 *
 * Registers the dashboard on Harness's web server when one is composed. The
 * server is an optional capability: a headless deployment, the CLI, or the
 * desktop app may not have one, so the routes are registered only when
 * `ctx.get('webServer')` answers. Absence is not an error, and the plugin's
 * enforcement path does not depend on any of this.
 *
 * Two route shapes are registered:
 *
 * - `/agentjail` serves HTML to a browser and text to anything else, so the same
 *   URL is useful in a browser tab and in a terminal.
 * - `/agentjail/api/*` serves JSON for the page and for scripts.
 *
 * Both are read-only. The one mutation, revoking a grant, removes an
 * authorization, so an exposed dashboard cannot be used to widen access.
 * @module dsh-plugin-agentjail/ui/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dashboardPayload, renderDashboardHtml, renderDashboardText } from './dashboard.js'
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
  /** Page refresh interval in milliseconds; `0` disables it. */
  refreshMs: number
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

/**
 * Decide whether the caller asked for JSON or plain text.
 *
 * `curl` sends a wildcard Accept header, so anything that is not explicitly HTML and does not
 * accept HTML gets text. That makes `curl http://host/agentjail` readable
 * without a flag, which is the common case for an operator checking on a box.
 * @param req - the incoming request.
 * @param override - an explicit `?format=` value, when present.
 * @returns the response format.
 */
export function negotiateFormat(
  req: IncomingMessage,
  override?: string | null,
): 'html' | 'text' | 'json' {
  if (override === 'json') return 'json'
  if (override === 'text') return 'text'
  if (override === 'html') return 'html'
  const accept = String(req.headers['accept'] ?? '')
  if (accept.includes('application/json')) return 'json'
  if (accept.includes('text/html')) return 'html'
  return 'text'
}

/**
 * Register the dashboard routes.
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
        if (format === 'html') {
          send(res, 200, 'text/html; charset=utf-8', renderDashboardHtml(data, options.refreshMs))
          return
        }
        send(res, 200, 'text/plain; charset=utf-8', renderDashboardText(data))
      },
    }),
  )

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
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          )
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
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          )
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
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          )
        }
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
