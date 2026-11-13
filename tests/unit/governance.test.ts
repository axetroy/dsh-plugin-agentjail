import { describe, expect, it } from 'vitest'
import { MetricsCollector } from '../../src/governance/metrics.js'
import { buildReport, policyDigest, renderReport } from '../../src/governance/report.js'
import { AuditLog } from '../../src/audit/audit-log.js'

function collector(overrides: Partial<ConstructorParameters<typeof MetricsCollector>[0]> = {}) {
  return new MetricsCollector({
    windowMs: 10000,
    denyRateAlertThreshold: 0.5,
    denyRateAlertMinSamples: 5,
    ...overrides,
  })
}

const sample = (verdict: 'allow' | 'deny' | 'ask', at: number, toolName = 'bash') => ({
  at,
  verdict,
  source: 'engine' as const,
  toolName,
  sessionId: 'sess-1',
  durationMs: 5,
})

describe('MetricsCollector', () => {
  it('counts decisions per verdict', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000))
    metrics.observe(sample('deny', 1001))
    metrics.observe(sample('ask', 1002))
    const snapshot = metrics.snapshot(1003)
    expect(snapshot.total).toBe(3)
    expect(snapshot.byVerdict).toEqual({ allow: 1, deny: 1, ask: 1 })
  })

  it('computes deny and ask rates', () => {
    const metrics = collector()
    metrics.observe(sample('deny', 1000))
    metrics.observe(sample('deny', 1001))
    metrics.observe(sample('allow', 1002))
    metrics.observe(sample('allow', 1003))
    const snapshot = metrics.snapshot(1004)
    expect(snapshot.denyRate).toBeCloseTo(0.5)
    expect(snapshot.askRate).toBe(0)
  })

  it('breaks decisions down by tool, highest first', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000, 'bash'))
    metrics.observe(sample('allow', 1001, 'read'))
    metrics.observe(sample('allow', 1002, 'read'))
    const snapshot = metrics.snapshot(1003)
    expect(snapshot.byTool[0]).toEqual({ toolName: 'read', count: 2 })
    expect(snapshot.byTool[1]).toEqual({ toolName: 'bash', count: 1 })
  })

  it('computes the offload rate for non-engine sources', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000))
    metrics.observe({ ...sample('allow', 1001), source: 'cache' })
    metrics.observe({ ...sample('allow', 1002), source: 'grant' })
    metrics.observe({ ...sample('allow', 1003), source: 'exempt' })
    expect(metrics.snapshot(1004).offloadRate).toBeCloseTo(0.75)
  })

  it('computes mean and max latency', () => {
    const metrics = collector()
    metrics.observe({ ...sample('allow', 1000), durationMs: 10 })
    metrics.observe({ ...sample('allow', 1001), durationMs: 30 })
    const snapshot = metrics.snapshot(1002)
    expect(snapshot.meanDurationMs).toBe(20)
    expect(snapshot.maxDurationMs).toBe(30)
  })

  it('counts distinct sessions', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000))
    metrics.observe({ ...sample('allow', 1001), sessionId: 'other' })
    metrics.observe({ ...sample('allow', 1002), sessionId: 'other' })
    expect(metrics.snapshot(1003).sessions).toBe(2)
  })

  it('drops samples outside the window', () => {
    const metrics = collector({ windowMs: 1000 })
    metrics.observe(sample('deny', 1000))
    metrics.observe(sample('allow', 5000))
    const snapshot = metrics.snapshot(5000)
    expect(snapshot.total).toBe(1)
    expect(snapshot.byVerdict.deny).toBe(0)
  })

  it('raises a deny-rate alert once the threshold is crossed', () => {
    const metrics = collector({ denyRateAlertMinSamples: 4, denyRateAlertThreshold: 0.5 })
    let alert
    for (let index = 0; index < 4; index += 1) {
      alert = metrics.observe(sample('deny', 1000 + index)) ?? alert
    }
    expect(alert?.kind).toBe('deny-rate')
    expect(alert?.samples).toBe(4)
  })

  it('does not alert below the minimum sample count', () => {
    const metrics = collector({ denyRateAlertMinSamples: 10 })
    let alert
    for (let index = 0; index < 5; index += 1) {
      alert = metrics.observe(sample('deny', 1000 + index)) ?? alert
    }
    expect(alert).toBeUndefined()
  })

  it('does not alert when the deny rate is within bounds', () => {
    const metrics = collector({ denyRateAlertMinSamples: 4, denyRateAlertThreshold: 0.9 })
    let alert
    const verdicts = ['deny', 'allow', 'deny', 'allow'] as const
    for (let index = 0; index < verdicts.length; index += 1) {
      alert = metrics.observe(sample(verdicts[index] ?? 'allow', 1000 + index)) ?? alert
    }
    expect(alert).toBeUndefined()
    expect(metrics.snapshot(1010).denyRate).toBeCloseTo(0.5)
  })

  it('resets every sample', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000))
    metrics.reset()
    expect(metrics.size).toBe(0)
  })

  it('reports zeroed statistics for an empty window', () => {
    const snapshot = collector().snapshot(1000)
    expect(snapshot.total).toBe(0)
    expect(snapshot.denyRate).toBe(0)
    expect(snapshot.meanDurationMs).toBe(0)
    expect(snapshot.windowStart).toBeUndefined()
  })
})

describe('policyDigest', () => {
  const input = {
    enforcement: 'enforce',
    failureAction: 'deny',
    defaultAction: 'deny',
    askAction: 'ask',
    exemptions: ['read'],
    overrideKeys: ['tool:bash'],
    cacheEnabled: true,
  }

  it('is stable regardless of input ordering', () => {
    const first = policyDigest(input)
    const second = policyDigest({ ...input, exemptions: ['read'], overrideKeys: ['tool:bash'] })
    expect(first.digest).toBe(second.digest)
  })

  it('changes when the failure action changes', () => {
    expect(policyDigest(input).digest).not.toBe(
      policyDigest({ ...input, failureAction: 'allow' }).digest,
    )
  })

  it('reports the configured counts', () => {
    const digest = policyDigest(input)
    expect(digest.overrideCount).toBe(1)
    expect(digest.exemptionCount).toBe(1)
  })
})

describe('buildReport and renderReport', () => {
  function report() {
    const metrics = collector()
    metrics.observe(sample('deny', Date.now(), 'bash'))
    const audit = new AuditLog({
      enabled: true,
      storage: 'memory',
      filePath: '',
      maxFileBytes: 0,
      maxRotatedFiles: 0,
      redactSensitiveData: true,
      maxValueChars: 100,
    })
    return buildReport({
      options: { title: 'test report', includePolicyDigest: true, recentLimit: 10 },
      metrics,
      audit,
      health: {
        state: 'healthy',
        socketPath: '/tmp/daemon.sock',
        connected: true,
        consecutiveFailures: 0,
      },
      grants: [],
      policy: policyDigest({
        enforcement: 'enforce',
        failureAction: 'deny',
        defaultAction: 'deny',
        askAction: 'ask',
        exemptions: [],
        overrideKeys: [],
        cacheEnabled: true,
      }),
    })
  }

  it('assembles the report fields', () => {
    const assembled = report()
    expect(assembled.title).toBe('test report')
    expect(assembled.metrics.total).toBe(1)
    expect(assembled.health.state).toBe('healthy')
    expect(assembled.policy?.digest).toBeDefined()
  })

  it('omits the policy digest when disabled', () => {
    const metrics = collector()
    const audit = new AuditLog({
      enabled: false,
      storage: 'none',
      filePath: '',
      maxFileBytes: 0,
      maxRotatedFiles: 0,
      redactSensitiveData: true,
      maxValueChars: 100,
    })
    const assembled = buildReport({
      options: { title: 't', includePolicyDigest: false, recentLimit: 5 },
      metrics,
      audit,
      health: { state: 'unknown', socketPath: '/tmp/s', connected: false, consecutiveFailures: 0 },
      grants: [],
    })
    expect(assembled.policy).toBeUndefined()
  })

  it('renders a readable text summary', () => {
    const text = renderReport(report())
    expect(text).toContain('test report')
    expect(text).toContain('Enforcement')
    expect(text).toContain('Engine')
    expect(text).toContain('Recent decisions')
    expect(text).toContain('deny rate')
  })
})

describe('MetricsCollector capacity and ordering branches', () => {
  it('caps retained samples at the configured maximum', () => {
    // The cap keeps the newest samples, so an unbounded stream cannot grow the
    // window without limit.
    const metrics = new MetricsCollector(
      { windowMs: 1_000_000, denyRateAlertThreshold: 0.5, denyRateAlertMinSamples: 1000 },
      3,
    )
    for (let index = 0; index < 5; index += 1) {
      metrics.observe(sample('allow', 1000 + index, `tool-${index}`))
    }
    expect(metrics.size).toBe(3)
    // Equal counts sort by name, so the retained three come back in that order.
    expect(metrics.snapshot(2000).byTool.map((entry) => entry.toolName)).toEqual([
      'tool-2',
      'tool-3',
      'tool-4',
    ])
  })

  it('breaks a tool-count tie by tool name, so the order is stable', () => {
    const metrics = collector()
    metrics.observe(sample('allow', 1000, 'zebra'))
    metrics.observe(sample('allow', 1001, 'alpha'))
    expect(metrics.snapshot(1002).byTool.map((entry) => entry.toolName)).toEqual(['alpha', 'zebra'])
  })

  it('suppresses a second alert inside the same window', () => {
    // One alert per window: a sustained high deny rate must not page per call.
    const metrics = collector({ denyRateAlertMinSamples: 2, denyRateAlertThreshold: 0.5 })
    expect(metrics.observe(sample('deny', 1000))).toBeUndefined()
    expect(metrics.observe(sample('deny', 1001))?.kind).toBe('deny-rate')
    expect(metrics.observe(sample('deny', 1002))).toBeUndefined()
  })
})

describe('renderReport optional branches', () => {
  it('prints daemon version and last error when the health snapshot has them', () => {
    const metrics = collector()
    const audit = new AuditLog({
      enabled: true,
      storage: 'memory',
      filePath: '',
      maxFileBytes: 0,
      maxRotatedFiles: 0,
      redactSensitiveData: true,
      maxValueChars: 100,
    })
    const assembled = buildReport({
      options: { title: 't', includePolicyDigest: true, recentLimit: 5 },
      metrics,
      audit,
      health: {
        state: 'degraded',
        socketPath: '/tmp/s',
        connected: false,
        consecutiveFailures: 2,
        daemonVersion: '0.9.0',
        lastError: 'socket gone',
      },
      grants: [
        {
          id: 'g1',
          scope: 'session',
          toolName: 'bash',
          sessionId: 's',
          digest: 'd',
          issuedAt: 0,
          expiresAt: Number.POSITIVE_INFINITY,
        },
        {
          id: 'g2',
          scope: 'once',
          toolName: 'write',
          sessionId: 's',
          digest: 'e',
          issuedAt: 0,
          expiresAt: 1_800_000_000_000,
        },
      ],
    })
    const text = renderReport(assembled)
    expect(text).toContain('version: 0.9.0')
    expect(text).toContain('last error: socket gone')
    // No decisions yet, so the top-tools list prints its empty marker.
    expect(text).toContain('(no decisions yet)')
    expect(text).toContain('expires=never')
    expect(text).toContain('expires=')
  })

  it('prints the no-records marker when the recent list is empty', () => {
    const metrics = collector()
    const audit = new AuditLog({
      enabled: true,
      storage: 'memory',
      filePath: '',
      maxFileBytes: 0,
      maxRotatedFiles: 0,
      redactSensitiveData: true,
      maxValueChars: 100,
    })
    const assembled = buildReport({
      options: { title: 't', includePolicyDigest: true, recentLimit: 5 },
      metrics,
      audit,
      health: {
        state: 'healthy',
        socketPath: '/tmp/s',
        connected: true,
        consecutiveFailures: 0,
      },
      grants: [],
    })
    expect(renderReport(assembled)).toContain('(none)')
  })
})
