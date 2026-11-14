import { describe, expect, it } from 'vitest'
import {
  dataUrl,
  decisionLabel,
  formatDuration,
  formatRate,
  formatTimestamp,
  healthDot,
  verdictTone,
  type DecisionRow,
} from '../../src/client/format.js'

const row = (overrides: Partial<DecisionRow> = {}): DecisionRow => ({
  seq: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  toolName: 'Bash',
  verdict: 'deny',
  source: 'engine',
  ...overrides,
})

describe('verdict tones', () => {
  it('maps every verdict the engine can emit', () => {
    expect(verdictTone('deny')).toBe('bad')
    expect(verdictTone('ask')).toBe('warn')
    expect(verdictTone('allow')).toBe('ok')
  })

  it('treats anything unrecognized as muted', () => {
    expect(verdictTone('deferred')).toBe('muted')
  })
})

describe('figure formatting', () => {
  it('renders a ratio as a one-decimal percentage', () => {
    expect(formatRate(0.25)).toBe('25.0%')
    expect(formatRate(0)).toBe('0.0%')
  })

  it('renders an em dash when the ratio is not finite', () => {
    expect(formatRate(Number.NaN)).toBe('—')
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('renders a duration in milliseconds', () => {
    expect(formatDuration(3)).toBe('3.0 ms')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('renders an epoch timestamp as ISO', () => {
    expect(formatTimestamp(1_800_000_000_000)).toBe('2027-01-15T08:00:00.000Z')
    expect(formatTimestamp(Number.NaN)).toBe('—')
  })
})

describe('decision labelling', () => {
  it('prefers the rule id the engine named', () => {
    expect(decisionLabel(row({ ruleId: 'no-rm-rf' }))).toBe('no-rm-rf')
  })

  it('falls back to the source when there is no rule id', () => {
    expect(decisionLabel(row({ ruleId: null }))).toBe('engine')
    expect(decisionLabel(row({ ruleId: '' }))).toBe('engine')
    expect(decisionLabel(row())).toBe('engine')
  })
})

describe('health dots', () => {
  it('maps each engine state onto the shared vocabulary', () => {
    expect(healthDot('healthy')).toBe('done')
    expect(healthDot('degraded')).toBe('warning')
    expect(healthDot('unhealthy')).toBe('error')
    expect(healthDot('incompatible')).toBe('error')
  })

  it('shows an unknown state as idle', () => {
    expect(healthDot('starting')).toBe('idle')
  })
})

describe('data URLs', () => {
  it('joins a base path and a suffix', () => {
    expect(dataUrl('/agentjail', '/api/summary')).toBe('/agentjail/api/summary')
  })

  it('tolerates a trailing slash on the base path', () => {
    expect(dataUrl('/agentjail/', '/api/summary')).toBe('/agentjail/api/summary')
  })

  it('falls back to the shipped base path when the base is empty', () => {
    expect(dataUrl('', '/api/health')).toBe('/agentjail/api/health')
  })
})
