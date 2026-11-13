/**
 * Security reports.
 *
 * A report is the operator-facing summary of what the plugin enforced: verdict
 * distribution, per-tool activity, outstanding approvals, engine health, and the
 * policy digest the verdicts were computed against. It is assembled from the
 * audit trail and metrics window, so it describes observed behavior rather than
 * a re-derivation of it.
 * @module dsh-plugin-agentjail/governance/report
 */

import type { AuditLog, AuditRecord } from '../audit/audit-log.js'
import type { MetricsCollector, MetricsSnapshot } from './metrics.js'
import type { Grant } from '../security/grants.js'
import type { HealthSnapshot } from '../adapter/agentjail-client.js'
import { fnv1a, stableStringify } from '../utils/request-id.js'

/** Options controlling report generation. */
export interface ReportOptions {
  /** Report title. */
  title: string
  /** Whether to include the policy digest. */
  includePolicyDigest: boolean
  /** Maximum recent decisions listed in the report. */
  recentLimit: number
}

/** A policy digest describing the configuration verdicts were computed under. */
export interface PolicyDigest {
  /** Digest of the normalized policy configuration. */
  digest: string
  /** Enforcement mode in force. */
  enforcement: string
  /** Failure action in force. */
  failureAction: string
  /** Default action in force. */
  defaultAction: string
  /** Number of configured scope overrides. */
  overrideCount: number
  /** Number of configured exemptions. */
  exemptionCount: number
  /** Whether verdict caching was enabled. */
  cacheEnabled: boolean
}

/** A complete security report. */
export interface SecurityReport {
  /** Report title. */
  title: string
  /** ISO-8601 generation timestamp. */
  generatedAt: string
  /** Aggregate statistics over the metrics window. */
  metrics: MetricsSnapshot
  /** Engine link health at generation time. */
  health: HealthSnapshot
  /** Outstanding approvals at generation time. */
  grants: Grant[]
  /** Policy digest, when enabled. */
  policy?: PolicyDigest
  /** Most recent decisions, newest first. */
  recent: AuditRecord[]
  /** Number of audit records retained in memory. */
  auditRecords: number
  /** Total audit records written since process start. */
  auditTotal: number
}

/**
 * Compute a digest of the effective policy configuration.
 *
 * The digest covers only the fields that change what a verdict can be, so two
 * deployments with the same digest enforce the same policy even if unrelated
 * settings differ.
 * @param input - the policy-bearing configuration fields.
 * @returns the policy digest.
 */
export function policyDigest(input: {
  enforcement: string
  failureAction: string
  defaultAction: string
  askAction: string
  exemptions: readonly string[]
  overrideKeys: readonly string[]
  cacheEnabled: boolean
}): PolicyDigest {
  const canonical = stableStringify({
    enforcement: input.enforcement,
    failureAction: input.failureAction,
    defaultAction: input.defaultAction,
    askAction: input.askAction,
    exemptions: [...input.exemptions].sort(),
    overrides: [...input.overrideKeys].sort(),
    cacheEnabled: input.cacheEnabled,
  })
  return {
    digest: fnv1a(canonical),
    enforcement: input.enforcement,
    failureAction: input.failureAction,
    defaultAction: input.defaultAction,
    overrideCount: input.overrideKeys.length,
    exemptionCount: input.exemptions.length,
    cacheEnabled: input.cacheEnabled,
  }
}

/**
 * Assemble a security report from the live plugin state.
 * @param input - the report inputs.
 * @returns the assembled report.
 */
export function buildReport(input: {
  options: ReportOptions
  metrics: MetricsCollector
  audit: AuditLog
  health: HealthSnapshot
  grants: readonly Grant[]
  policy?: PolicyDigest
  now?: number
}): SecurityReport {
  const now = input.now ?? Date.now()
  const report: SecurityReport = {
    title: input.options.title,
    generatedAt: new Date(now).toISOString(),
    metrics: input.metrics.snapshot(now),
    health: { ...input.health },
    grants: input.grants.map((grant) => ({ ...grant })),
    recent: input.audit.query({ limit: input.options.recentLimit }),
    auditRecords: input.audit.size,
    auditTotal: input.audit.total,
  }
  if (input.options.includePolicyDigest && input.policy !== undefined) {
    report.policy = input.policy
  }
  return report
}

/**
 * Render a report as a human-readable plain-text summary.
 *
 * The summary leads with the numbers an operator acts on and keeps identifiers
 * alongside them, so a report pasted into a ticket stays actionable.
 * @param report - the report to render.
 * @returns the rendered text.
 */
export function renderReport(report: SecurityReport): string {
  const { metrics, health } = report
  const lines: string[] = []
  lines.push(`${report.title}`)
  lines.push(`generated: ${report.generatedAt}`)
  lines.push('')
  lines.push('Enforcement')
  lines.push(`  decisions (window): ${metrics.total}`)
  lines.push(
    `  allow: ${metrics.byVerdict.allow}  deny: ${metrics.byVerdict.deny}  ask: ${metrics.byVerdict.ask}`,
  )
  lines.push(`  deny rate: ${(metrics.denyRate * 100).toFixed(1)}%`)
  lines.push(`  ask rate: ${(metrics.askRate * 100).toFixed(1)}%`)
  lines.push(`  served without the engine: ${(metrics.offloadRate * 100).toFixed(1)}%`)
  lines.push(
    `  mean latency: ${metrics.meanDurationMs.toFixed(1)}ms  max: ${metrics.maxDurationMs}ms`,
  )
  lines.push(`  sessions: ${metrics.sessions}`)
  lines.push('')
  lines.push('Engine')
  lines.push(`  state: ${health.state}`)
  lines.push(`  socket: ${health.socketPath}`)
  lines.push(`  connected: ${health.connected}`)
  lines.push(`  consecutive failures: ${health.consecutiveFailures}`)
  if (health.daemonVersion !== undefined) lines.push(`  version: ${health.daemonVersion}`)
  if (health.lastError !== undefined) lines.push(`  last error: ${health.lastError}`)
  lines.push('')
  lines.push('Top tools')
  if (metrics.byTool.length === 0) lines.push('  (no decisions yet)')
  for (const entry of metrics.byTool.slice(0, 10)) {
    lines.push(`  ${entry.toolName}: ${entry.count}`)
  }
  lines.push('')
  lines.push(`Outstanding approvals: ${report.grants.length}`)
  for (const grant of report.grants.slice(0, 10)) {
    const expiry =
      grant.expiresAt === Number.POSITIVE_INFINITY
        ? 'never'
        : new Date(grant.expiresAt).toISOString()
    lines.push(`  ${grant.toolName} (${grant.scope}) session=${grant.sessionId} expires=${expiry}`)
  }
  if (report.policy !== undefined) {
    lines.push('')
    lines.push('Policy')
    lines.push(`  digest: ${report.policy.digest}`)
    lines.push(
      `  enforcement: ${report.policy.enforcement}  failure: ${report.policy.failureAction}  default: ${report.policy.defaultAction}`,
    )
    lines.push(
      `  overrides: ${report.policy.overrideCount}  exemptions: ${report.policy.exemptionCount}`,
    )
  }
  lines.push('')
  lines.push(`Audit records: ${report.auditRecords} retained / ${report.auditTotal} total`)
  lines.push('')
  lines.push('Recent decisions')
  if (report.recent.length === 0) lines.push('  (none)')
  for (const record of report.recent.slice(0, 20)) {
    const rule = record.ruleId === undefined ? '' : ` rule=${record.ruleId}`
    lines.push(
      `  ${record.timestamp} ${record.verdict.toUpperCase()} ${record.toolName} via ${record.source}${rule}`,
    )
  }
  return lines.join('\n')
}
