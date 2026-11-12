/**
 * Risk metrics and governance statistics.
 *
 * A sliding window of decisions feeds the numbers an operator needs to answer
 * "is this deployment behaving": allow/deny/ask counts, per-tool breakdown, and
 * a deny rate that raises an alert when it crosses the configured threshold.
 *
 * Statistics are derived only from decisions this plugin made, so they are
 * complete for the plugin's own enforcement surface and make no claim about
 * traffic that bypassed it.
 * @module dsh-plugin-agentjail/governance/metrics
 */

import type { AuditVerdict, DecisionSource } from '../audit/audit-log.js'

/** One observed decision, reduced to what statistics need. */
export interface MetricSample {
  /** Epoch milliseconds the decision was made. */
  at: number
  /** Verdict applied. */
  verdict: AuditVerdict
  /** What produced the verdict. */
  source: DecisionSource
  /** Harness tool name. */
  toolName: string
  /** Session the decision belongs to. */
  sessionId: string
  /** Evaluation duration in milliseconds. */
  durationMs: number
}

/** Aggregate statistics over the retained window. */
export interface MetricsSnapshot {
  /** Total decisions in the window. */
  total: number
  /** Decisions per verdict. */
  byVerdict: Record<AuditVerdict, number>
  /** Decisions per source. */
  bySource: Record<string, number>
  /** Decisions per tool, highest first. */
  byTool: Array<{ toolName: string; count: number }>
  /** Deny ratio over the window, in the range 0..1. */
  denyRate: number
  /** Ask ratio over the window, in the range 0..1. */
  askRate: number
  /** Ratio of decisions that did not reach the engine (cache, grant, override, exempt). */
  offloadRate: number
  /** Mean evaluation duration in milliseconds. */
  meanDurationMs: number
  /** Highest observed evaluation duration in milliseconds. */
  maxDurationMs: number
  /** Earliest sample time in the window, when any sample exists. */
  windowStart?: number
  /** Latest sample time in the window, when any sample exists. */
  windowEnd?: number
  /** Distinct sessions observed in the window. */
  sessions: number
}

/** A raised risk alert. */
export interface RiskAlert {
  /** Alert kind. */
  kind: 'deny-rate'
  /** Human-readable alert message. */
  message: string
  /** Observed deny rate. */
  denyRate: number
  /** Configured threshold that was crossed. */
  threshold: number
  /** Number of samples the rate was computed over. */
  samples: number
}

/** Metrics settings. */
export interface MetricsOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number
  /** Deny ratio that raises an alert. */
  denyRateAlertThreshold: number
  /** Minimum samples before the deny-rate alert may fire. */
  denyRateAlertMinSamples: number
}

/**
 * A bounded sliding window of decisions with derived statistics.
 *
 * Samples older than the window are dropped on every read and write, so memory
 * use is bounded by the window length rather than by process uptime.
 */
export class MetricsCollector {
  private samples: MetricSample[] = []
  private readonly maxSamples: number
  /** `-Infinity` so the first window is eligible rather than suppressed. */
  private lastDenyRateAlertAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly options: MetricsOptions,
    maxSamples = 10000,
  ) {
    this.maxSamples = maxSamples
  }

  /**
   * Record one decision.
   * @param sample - the decision to record.
   * @returns a risk alert when this sample pushed the deny rate past the threshold.
   */
  observe(sample: MetricSample): RiskAlert | undefined {
    this.samples.push(sample)
    this.sweep(sample.at)
    return this.checkDenyRate(sample.at)
  }

  /** Drop samples outside the window and enforce the sample cap. */
  private sweep(now: number): void {
    const cutoff = now - this.options.windowMs
    let firstRetained = 0
    while (firstRetained < this.samples.length) {
      const sample = this.samples[firstRetained]
      if (sample === undefined || sample.at >= cutoff) break
      firstRetained += 1
    }
    if (firstRetained > 0) this.samples = this.samples.slice(firstRetained)
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - this.maxSamples)
    }
  }

  /**
   * Compute the current snapshot.
   * @param now - current epoch milliseconds.
   * @returns the aggregate statistics.
   */
  snapshot(now = Date.now()): MetricsSnapshot {
    this.sweep(now)
    const byVerdict: Record<AuditVerdict, number> = { allow: 0, deny: 0, ask: 0 }
    const bySource: Record<string, number> = {}
    const byToolCounts = new Map<string, number>()
    const sessions = new Set<string>()
    let durationTotal = 0
    let maxDurationMs = 0
    let offloaded = 0

    for (const sample of this.samples) {
      byVerdict[sample.verdict] += 1
      bySource[sample.source] = (bySource[sample.source] ?? 0) + 1
      byToolCounts.set(sample.toolName, (byToolCounts.get(sample.toolName) ?? 0) + 1)
      sessions.add(sample.sessionId)
      durationTotal += sample.durationMs
      if (sample.durationMs > maxDurationMs) maxDurationMs = sample.durationMs
      if (sample.source !== 'engine') offloaded += 1
    }

    const total = this.samples.length
    const byTool = [...byToolCounts.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count || (a.toolName < b.toolName ? -1 : 1))

    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    return {
      total,
      byVerdict,
      bySource,
      byTool,
      denyRate: total === 0 ? 0 : byVerdict.deny / total,
      askRate: total === 0 ? 0 : byVerdict.ask / total,
      offloadRate: total === 0 ? 0 : offloaded / total,
      meanDurationMs: total === 0 ? 0 : durationTotal / total,
      maxDurationMs,
      ...(first !== undefined ? { windowStart: first.at } : {}),
      ...(last !== undefined ? { windowEnd: last.at } : {}),
      sessions: sessions.size,
    }
  }

  /**
   * Raise a deny-rate alert when the window crosses the configured threshold.
   *
   * At most one alert fires per window so a sustained high deny rate produces
   * one signal rather than one per decision.
   * @param now - current epoch milliseconds.
   * @returns the alert, or `undefined` when the rate is within bounds.
   */
  private checkDenyRate(now: number): RiskAlert | undefined {
    if (this.samples.length < this.options.denyRateAlertMinSamples) return undefined
    if (now - this.lastDenyRateAlertAt < this.options.windowMs) return undefined
    const snapshot = this.snapshot(now)
    if (snapshot.denyRate <= this.options.denyRateAlertThreshold) return undefined
    this.lastDenyRateAlertAt = now
    return {
      kind: 'deny-rate',
      message: `deny rate ${(snapshot.denyRate * 100).toFixed(1)}% over ${snapshot.total} decisions exceeds the ${(this.options.denyRateAlertThreshold * 100).toFixed(1)}% threshold`,
      denyRate: snapshot.denyRate,
      threshold: this.options.denyRateAlertThreshold,
      samples: snapshot.total,
    }
  }

  /** Number of retained samples. */
  get size(): number {
    return this.samples.length
  }

  /** Drop every sample. */
  reset(): void {
    this.samples = []
    this.lastDenyRateAlertAt = Number.NEGATIVE_INFINITY
  }
}
