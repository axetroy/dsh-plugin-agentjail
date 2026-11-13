/**
 * Read-only security dashboard.
 *
 * The plugin's audit trail, risk statistics, engine health, and outstanding
 * approvals are useful while an agent is running, not only after the fact. This
 * module renders them as a self-contained page served by the Harness web server,
 * plus the JSON endpoints the page reads.
 *
 * It is deliberately read-only. Nothing here can widen a policy, clear a
 * denial, or turn the plugin's failure posture into an allow — a dashboard that
 * could do any of those would be a larger attack surface than the gate it
 * reports on.
 *
 * The page is static markup with no external requests, no framework, and no
 * inline event handlers, so it renders the same whether it is opened from the
 * Harness web UI or fetched with `curl`.
 * @module dsh-plugin-agentjail/ui/dashboard
 */

import type { AuditRecord } from '../audit/audit-log.js'
import type { MetricsSnapshot } from '../governance/metrics.js'
import type { HealthSnapshot } from '../adapter/agentjail-client.js'
import type { Grant } from '../security/grants.js'
import type { DecisionAlert } from '../security/decision.js'
import type { SupervisionState } from '../adapter/supervisor.js'

/** Everything the dashboard renders. */
export interface DashboardData {
  /** Engine health at the time of the request. */
  health: HealthSnapshot
  /** Aggregate risk statistics. */
  stats: MetricsSnapshot
  /** Recent audit records, newest first. */
  records: AuditRecord[]
  /** Outstanding approvals. */
  grants: Grant[]
  /** Alerts raised since plugin load. */
  alerts: DecisionAlert[]
  /** What the plugin is relying on for policy. */
  supervision: SupervisionState
  /** Enforcement mode in effect. */
  enforcement: string
  /** Verdict applied when the engine cannot answer. */
  failureAction: string
  /** Verdict applied when no rule matches. */
  defaultAction: string
  /** Current time, injected so rendering stays pure. */
  now: string
}

/** Escape text for interpolation into HTML. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Map a verdict onto a display tone. */
function verdictTone(verdict: string): string {
  if (verdict === 'deny') return 'bad'
  if (verdict === 'ask') return 'warn'
  if (verdict === 'allow') return 'ok'
  return 'muted'
}

/**
 * Build the JSON document the page's script reads.
 * @param data - the dashboard data.
 * @returns a serializable summary, already redacted by the audit layer.
 */
export function dashboardPayload(data: DashboardData): Record<string, unknown> {
  const stats = data.stats
  return {
    generatedAt: data.now,
    enforcement: data.enforcement,
    failureAction: data.failureAction,
    defaultAction: data.defaultAction,
    supervision: data.supervision,
    health: {
      state: data.health.state,
      socketPath: data.health.socketPath,
      lastError: data.health.lastError,
    },
    stats: {
      total: stats.total,
      allow: stats.byVerdict.allow,
      deny: stats.byVerdict.deny,
      ask: stats.byVerdict.ask,
      denyRate: stats.denyRate,
      askRate: stats.askRate,
      offloadRate: stats.offloadRate,
      meanDurationMs: stats.meanDurationMs,
    },
    grants: data.grants.map((grant) => ({
      id: grant.id,
      sessionId: grant.sessionId,
      toolName: grant.toolName,
      expiresAt: grant.expiresAt,
      scope: grant.scope,
      reason: grant.reason,
    })),
    alerts: data.alerts.slice(-50).map((alert) => ({
      kind: alert.kind,
      toolName: alert.toolName,
      sessionId: alert.sessionId,
      message: alert.message,
      ruleId: alert.ruleId,
      errorCode: alert.errorCode,
    })),
    records: data.records.map((record) => ({
      seq: record.seq,
      timestamp: record.timestamp,
      toolName: record.toolName,
      verdict: record.verdict,
      source: record.source,
      ruleId: record.ruleId,
      reason: record.reason,
      sessionId: record.sessionId,
      durationMs: record.durationMs,
    })),
  }
}

/** Render the summary tiles. */
function renderTiles(data: DashboardData): string {
  const stats = data.stats
  const denyRate = Number.isFinite(stats.denyRate) ? `${(stats.denyRate * 100).toFixed(1)}%` : '—'
  const healthy = data.health.state === 'healthy'
  const supervised = data.supervision === 'external' || data.supervision === 'started'
  const tiles: Array<[string, string, string]> = [
    ['Engine', data.health.state, healthy ? 'ok' : 'bad'],
    ['Supervision', data.supervision, supervised ? 'ok' : 'warn'],
    ['Decisions', String(stats.total), 'muted'],
    ['Denied', String(stats.byVerdict.deny), stats.byVerdict.deny > 0 ? 'bad' : 'ok'],
    ['Asked', String(stats.byVerdict.ask), stats.byVerdict.ask > 0 ? 'warn' : 'muted'],
    ['Deny rate', denyRate, 'muted'],
    ['Approvals', String(data.grants.length), 'muted'],
  ]
  return tiles
    .map(
      ([label, value, tone]) =>
        `<div class="tile"><div class="tile-label">${escapeHtml(label)}</div><div class="tile-value ${tone}">${escapeHtml(value)}</div></div>`,
    )
    .join('\n        ')
}

/** Render the audit table body. */
function renderRecords(records: AuditRecord[]): string {
  if (records.length === 0) {
    return '<tr><td colspan="6" class="empty">No decisions recorded yet.</td></tr>'
  }
  return records
    .slice(0, 200)
    .map(
      (record) => `<tr>
          <td class="mono muted">${escapeHtml(record.seq)}</td>
          <td class="mono muted">${escapeHtml(record.timestamp)}</td>
          <td class="mono">${escapeHtml(record.toolName)}</td>
          <td><span class="pill ${verdictTone(record.verdict)}">${escapeHtml(record.verdict)}</span></td>
          <td class="mono muted">${escapeHtml(record.ruleId ?? record.source)}</td>
          <td>${escapeHtml(record.reason ?? '')}</td>
        </tr>`,
    )
    .join('\n        ')
}

/** Render the grant table body. */
function renderGrants(grants: Grant[]): string {
  if (grants.length === 0) {
    return '<tr><td colspan="4" class="empty">No outstanding approvals.</td></tr>'
  }
  return grants
    .map(
      (grant) => `<tr>
          <td class="mono">${escapeHtml(grant.toolName)}</td>
          <td class="mono muted">${escapeHtml(grant.sessionId)}</td>
          <td class="mono muted">${escapeHtml(new Date(grant.expiresAt).toISOString())}</td>
          <td>${grant.scope === 'once' ? 'one-time' : 'session'}</td>
        </tr>`,
    )
    .join('\n        ')
}

/** Render the alert list. */
function renderAlerts(alerts: DecisionAlert[]): string {
  if (alerts.length === 0) {
    return '<li class="empty">No alerts.</li>'
  }
  return alerts
    .slice(-20)
    .reverse()
    .map(
      (alert) =>
        `<li><span class="pill ${verdictTone(alert.kind === 'deny-rate' ? 'deny' : 'ask')}">${escapeHtml(alert.kind)}</span> <span class="mono muted">${escapeHtml(alert.toolName)}</span> ${escapeHtml(alert.message)}</li>`,
    )
    .join('\n        ')
}

/** The dashboard stylesheet, inlined so the page needs no second request. */
const STYLES = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 2rem 1.5rem 4rem;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: Canvas; color: CanvasText;
    }
    main { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
    h2 { font-size: .95rem; margin: 2rem 0 .6rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
    .sub { opacity: .6; margin: 0 0 1.5rem; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; }
    .tile { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: .75rem .9rem; }
    .tile-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; opacity: .6; }
    .tile-value { font-size: 1.25rem; font-weight: 600; margin-top: .2rem; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); vertical-align: top; }
    th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; opacity: .6; font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted { opacity: .65; }
    .pill { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
    .pill.ok { background: color-mix(in srgb, #16a34a 22%, transparent); }
    .pill.bad { background: color-mix(in srgb, #dc2626 22%, transparent); }
    .pill.warn { background: color-mix(in srgb, #d97706 22%, transparent); }
    .pill.muted { background: color-mix(in srgb, CanvasText 12%, transparent); }
    .ok { color: #16a34a; } .bad { color: #dc2626; } .warn { color: #d97706; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: .3rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
    .empty { opacity: .5; font-style: italic; }
    footer { margin-top: 3rem; font-size: .8rem; opacity: .55; }
    a { color: inherit; }
`

/**
 * Render the dashboard as a standalone HTML document.
 * @param data - the dashboard data.
 * @param refreshMs - page refresh interval in milliseconds; `0` disables it.
 * @returns a complete HTML document.
 */
export function renderDashboardHtml(data: DashboardData, refreshMs = 5000): string {
  const refreshScript =
    refreshMs > 0
      ? `<script>
      // Reload the page on an interval so a long-running session keeps showing
      // new decisions without the operator refreshing by hand.
      setTimeout(function () { location.reload() }, ${refreshMs})
    </script>`
      : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>AgentJail security dashboard</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <h1>AgentJail security dashboard</h1>
      <p class="sub">
        Read-only. Enforcement <strong>${escapeHtml(data.enforcement)}</strong>,
        failure action <strong>${escapeHtml(data.failureAction)}</strong>,
        default action <strong>${escapeHtml(data.defaultAction)}</strong>.
        Generated ${escapeHtml(data.now)}.
      </p>

      <div class="tiles">
        ${renderTiles(data)}
      </div>

      <h2>Recent decisions</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Time</th><th>Tool</th><th>Verdict</th><th>Rule / source</th><th>Reason</th></tr>
        </thead>
        <tbody>
        ${renderRecords(data.records)}
        </tbody>
      </table>

      <h2>Outstanding approvals</h2>
      <table>
        <thead>
          <tr><th>Tool</th><th>Session</th><th>Expires</th><th>Scope</th></tr>
        </thead>
        <tbody>
        ${renderGrants(data.grants)}
        </tbody>
      </table>

      <h2>Alerts</h2>
      <ul>
        ${renderAlerts(data.alerts)}
      </ul>

      <footer>
        Socket <span class="mono">${escapeHtml(data.health.socketPath)}</span>.
        JSON at <span class="mono">./api/summary</span>.
      </footer>
    </main>
    ${refreshScript}
  </body>
</html>
`
}

/**
 * Render the plain-text dashboard, for `curl` and for operators who prefer it.
 * @param data - the dashboard data.
 * @returns a fixed-width summary.
 */
export function renderDashboardText(data: DashboardData): string {
  const stats = data.stats
  const lines: string[] = [
    'AgentJail security dashboard',
    `generated   ${data.now}`,
    `enforcement ${data.enforcement}  failure ${data.failureAction}  default ${data.defaultAction}`,
    `engine      ${data.health.state}  (${data.health.socketPath})`,
    `supervision ${data.supervision}`,
    '',
    `decisions   ${stats.total}  allow ${stats.byVerdict.allow}  deny ${stats.byVerdict.deny}  ask ${stats.byVerdict.ask}`,
    `deny rate   ${Number.isFinite(stats.denyRate) ? `${(stats.denyRate * 100).toFixed(1)}%` : '—'}`,
    `approvals   ${data.grants.length}`,
    '',
    'recent decisions:',
  ]
  if (data.records.length === 0) {
    lines.push('  (none)')
  } else {
    for (const record of data.records.slice(0, 50)) {
      lines.push(
        `  ${String(record.seq).padStart(6)}  ${record.timestamp}  ${record.verdict.padEnd(5)}  ${record.toolName}  ${record.ruleId ?? record.source}`,
      )
    }
  }
  if (data.alerts.length > 0) {
    lines.push('', 'alerts:')
    for (const alert of data.alerts.slice(-10)) {
      lines.push(`  ${alert.kind}  ${alert.toolName}  ${alert.message}`)
    }
  }
  return lines.join('\n')
}
