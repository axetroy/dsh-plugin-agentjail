/**
 * Read-only security dashboard data.
 *
 * The plugin's audit trail, risk statistics, engine health, and outstanding
 * approvals are useful while an agent is running, not only after the fact. This
 * module builds the documents the AgentJail settings section reads, plus a text
 * rendering for an operator who has no browser.
 *
 * It is deliberately read-only. Nothing here can widen a policy, clear a
 * denial, or turn the plugin's failure posture into an allow — a view that
 * could do any of those would be a larger attack surface than the gate it
 * reports on.
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

/**
 * Build the JSON document the settings section reads.
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
