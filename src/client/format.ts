/**
 * Presentation folds for the AgentJail settings panel.
 *
 * Kept separate from the component so every branch — a missing rate, a
 * non-finite duration, an unknown verdict — is testable without a DOM.
 * @module dsh-plugin-agentjail/client/format
 */

/** One audit record as the decisions route serializes it. */
export interface DecisionRow {
  seq: number
  timestamp: string
  toolName: string
  verdict: string
  source: string
  ruleId?: string | null
  reason?: string | null
}

/** The summary document the plugin's data route answers with. */
export interface DashboardSummary {
  generatedAt: string
  enforcement: string
  failureAction: string
  defaultAction: string
  supervision: { state: string; managed: boolean; reason?: string }
  health: {
    state: string
    socketPath: string
    lastError?: string | null
    connected?: boolean
    consecutiveFailures?: number
    daemonVersion?: string | null
  }
  stats: {
    total: number
    allow: number
    deny: number
    ask: number
    denyRate: number
    askRate: number
    offloadRate: number
    meanDurationMs: number
  }
  grants: Array<{
    id: string
    sessionId: string
    toolName: string
    expiresAt: number
    scope: string
  }>
  alerts: Array<{ kind: string; toolName: string; message: string; ruleId?: string | null }>
}

/** Map a verdict onto a display tone name. */
export function verdictTone(verdict: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (verdict === 'deny') return 'bad'
  if (verdict === 'ask') return 'warn'
  if (verdict === 'allow') return 'ok'
  return 'muted'
}

/**
 * Render a ratio as a percentage.
 * @param value - the ratio, expected in `0..1`.
 * @returns a fixed-width percentage, or an em dash when it is not a number.
 */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

/**
 * Render a duration in milliseconds.
 * @param value - the duration.
 * @returns milliseconds with one decimal, or an em dash when it is not a number.
 */
export function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} ms`
}

/**
 * Render an epoch millisecond timestamp as an ISO string.
 * @param value - epoch milliseconds.
 * @returns the ISO string, or an em dash when it is not a number.
 */
export function formatTimestamp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return new Date(value).toISOString()
}

/**
 * Pick the label an operator should read for a decision.
 * @param row - the audit row.
 * @returns the rule id when the engine named one, otherwise the decision source.
 */
export function decisionLabel(row: DecisionRow): string {
  const ruleId = row.ruleId ?? ''
  return ruleId.length > 0 ? ruleId : row.source
}

/** Map engine health onto the shared status-dot vocabulary. */
export function healthDot(state: string): 'done' | 'warning' | 'error' | 'idle' {
  if (state === 'healthy') return 'done'
  if (state === 'degraded') return 'warning'
  if (state === 'unhealthy' || state === 'incompatible') return 'error'
  return 'idle'
}

/**
 * Build the path a section appends its data requests to.
 * @param basePath - the configured base path, without a trailing slash.
 * @param suffix - the route suffix, for example `/api/summary`.
 * @returns the same-origin path a `fetch` can use.
 */
export function dataUrl(basePath: string, suffix: string): string {
  const base = basePath.length > 0 ? basePath : '/agentjail'
  return `${base.endsWith('/') ? base.slice(0, -1) : base}${suffix}`
}
