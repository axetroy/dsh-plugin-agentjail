import { describe, expect, it } from 'vitest'
import {
  failureVerdict,
  grantScopeForApproval,
  isEnforcing,
  mapEngineAction,
  matchExemption,
  matchOverride,
  resolveDecision,
} from '../../src/security/decision.js'
import { GrantStore } from '../../src/security/grants.js'
import type { AgentJailClient, EvaluateOutcome } from '../../src/adapter/agentjail-client.js'
import { DaemonUnavailableError } from '../../src/utils/errors.js'
import { Config } from '../../src/config/schema.js'

/** Validate a partial config through the real schema, so defaults are exercised. */
function config(overrides: Record<string, unknown> = {}) {
  // The schema applies every default, so tests exercise the real resolved shape.
  return Config(overrides as never)
}

/** A client stub whose single method is scripted. */
function clientReturning(outcome: Partial<EvaluateOutcome>): AgentJailClient {
  return {
    evaluateCall: async (): Promise<EvaluateOutcome> => ({
      request: {
        hookEvent: 'PreToolUse',
        toolName: 'Bash',
        toolInput: {},
        sessionId: 's',
        agentId: 's',
        cwd: '/tmp',
        harnessToolName: 'bash',
      },
      digest: 'd',
      cached: false,
      durationMs: 1,
      ...outcome,
    }),
  } as unknown as AgentJailClient
}

const input = {
  toolName: 'bash',
  sessionId: 'sess-1',
  agentId: 'sess-1',
  digest: 'digest-1',
  arguments: { command: 'ls' },
}

describe('matchExemption', () => {
  it('matches an exact tool name', () => {
    expect(matchExemption(config({ exemptTools: ['read'] }), 'read')).toBe('exemptTools:read')
    expect(matchExemption(config({ exemptTools: ['read'] }), 'write')).toBeUndefined()
  })

  it('matches a configured prefix', () => {
    const cfg = config({ exemptToolPrefixes: ['mcp__trusted__'] })
    expect(matchExemption(cfg, 'mcp__trusted__read')).toBe('exemptToolPrefixes:mcp__trusted__')
    expect(matchExemption(cfg, 'mcp__other__read')).toBeUndefined()
  })

  it('ignores an empty prefix', () => {
    expect(matchExemption(config({ exemptToolPrefixes: [''] }), 'bash')).toBeUndefined()
  })
})

describe('matchOverride', () => {
  it('prefers an agent override over a session or tool override', () => {
    const cfg = config({
      overrides: {
        agents: { 'sess-1': { action: 'allow' } },
        sessions: { 'sess-1': { action: 'deny' } },
        tools: { bash: { action: 'ask' } },
      },
    })
    expect(
      matchOverride(cfg, { agentId: 'sess-1', sessionId: 'sess-1', toolName: 'bash' })?.action,
    ).toBe('allow')
  })

  it('falls back to a session then a tool override', () => {
    const cfg = config({
      overrides: { sessions: { 'sess-1': { action: 'deny' } }, tools: { bash: { action: 'ask' } } },
    })
    expect(
      matchOverride(cfg, { agentId: 'a', sessionId: 'sess-1', toolName: 'bash' })?.action,
    ).toBe('deny')
    expect(matchOverride(cfg, { agentId: 'a', sessionId: 'x', toolName: 'bash' })?.action).toBe(
      'ask',
    )
  })

  it('returns undefined with no matching override', () => {
    expect(
      matchOverride(config(), { agentId: 'a', sessionId: 's', toolName: 'bash' }),
    ).toBeUndefined()
  })
})

describe('mapEngineAction', () => {
  it('passes allow and deny through', () => {
    expect(mapEngineAction(config(), 'allow')).toBe('allow')
    expect(mapEngineAction(config(), 'deny')).toBe('deny')
  })

  it('maps ask through askAction', () => {
    expect(mapEngineAction(config({ askAction: 'ask' }), 'ask')).toBe('ask')
    expect(mapEngineAction(config({ askAction: 'deny' }), 'ask')).toBe('deny')
  })
})

describe('failureVerdict and isEnforcing', () => {
  it('defaults the failure action to deny', () => {
    expect(failureVerdict(config())).toBe('deny')
  })

  it('honours a configured failure action', () => {
    expect(failureVerdict(config({ failureAction: 'ask' }))).toBe('ask')
  })

  it('reports the enforcement mode', () => {
    expect(isEnforcing(config())).toBe(true)
    expect(isEnforcing(config({ enforcement: 'monitor' }))).toBe(false)
  })
})

describe('grantScopeForApproval', () => {
  it('returns a once grant when grants are enabled', () => {
    expect(grantScopeForApproval(config())).toBe('once')
  })

  it('returns undefined when grants are disabled', () => {
    expect(grantScopeForApproval(config({ approval: { grantsEnabled: false } }))).toBeUndefined()
  })
})

describe('resolveDecision', () => {
  const engine = (overrides: Record<string, unknown> = {}) => {
    const cfg = config(overrides)
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    return { cfg, grants }
  }

  it('allows an exempt tool without consulting the engine', async () => {
    const { cfg, grants } = engine({ exemptTools: ['bash'] })
    const client = clientReturning({ error: new DaemonUnavailableError('should not be called') })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('allow')
    expect(resolved.source).toBe('exempt')
  })

  it('applies a configured override before the engine', async () => {
    const { cfg, grants } = engine({
      overrides: { tools: { bash: { action: 'deny', reason: 'nope' } } },
    })
    const client = clientReturning({})
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('deny')
    expect(resolved.source).toBe('override')
    expect(resolved.reason).toBe('nope')
  })

  it('consumes an outstanding grant before the engine', async () => {
    const { cfg, grants } = engine()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 'sess-1', digest: 'digest-1' })
    const client = clientReturning({})
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('allow')
    expect(resolved.source).toBe('grant')
    expect(resolved.grantId).toBeDefined()
  })

  it('applies the engine verdict', async () => {
    const { cfg, grants } = engine()
    const client = clientReturning({
      decision: { action: 'deny', ruleId: 'no-rm-rf', reason: 'blocked', raw: {} },
    })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('deny')
    expect(resolved.source).toBe('engine')
    expect(resolved.ruleId).toBe('no-rm-rf')
    expect(resolved.reason).toBe('blocked')
  })

  it('maps an engine ask through askAction', async () => {
    const { cfg, grants } = engine({ askAction: 'deny' })
    const client = clientReturning({
      decision: { action: 'ask', reason: 'needs approval', raw: {} },
    })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('deny')
    expect(resolved.reason).toBe('needs approval')
  })

  it('marks a cached verdict as coming from the cache', async () => {
    const { cfg, grants } = engine()
    const client = clientReturning({ decision: { action: 'allow', raw: {} }, cached: true })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.source).toBe('cache')
  })

  it('applies the failure action when the engine is unreachable', async () => {
    const { cfg, grants } = engine()
    const client = clientReturning({ error: new DaemonUnavailableError('socket gone') })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('deny')
    expect(resolved.source).toBe('failure-action')
    expect(resolved.error?.code).toBe('AGENTJAIL_DAEMON_UNAVAILABLE')
    expect(resolved.reason).toContain('socket gone')
  })

  it('honours a fail-open failure action only when explicitly configured', async () => {
    const { cfg, grants } = engine({ failureAction: 'allow' })
    const client = clientReturning({ error: new DaemonUnavailableError('socket gone') })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.verdict).toBe('allow')
    expect(resolved.source).toBe('failure-action')
  })

  it('raises an alert for a denial', async () => {
    const { cfg, grants } = engine()
    const alerts: unknown[] = []
    const client = clientReturning({
      decision: { action: 'deny', ruleId: 'no-rm-rf', reason: 'blocked', raw: {} },
    })
    await resolveDecision(
      { config: cfg, client, grants, onAlert: (alert) => alerts.push(alert) },
      input,
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ kind: 'denied', ruleId: 'no-rm-rf' })
  })

  it('raises an alert when the engine is unavailable', async () => {
    const { cfg, grants } = engine()
    const alerts: Array<{ kind: string }> = []
    const client = clientReturning({ error: new DaemonUnavailableError('socket gone') })
    await resolveDecision(
      { config: cfg, client, grants, onAlert: (alert) => alerts.push(alert) },
      input,
    )
    expect(alerts[0]?.kind).toBe('engine-unavailable')
  })

  it('does not consult grants when they are disabled', async () => {
    const { cfg, grants } = engine({ approval: { grantsEnabled: false } })
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 'sess-1', digest: 'digest-1' })
    const client = clientReturning({ decision: { action: 'deny', raw: {} } })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.source).toBe('engine')
  })

  it('builds a default reason when the engine supplies none', async () => {
    const { cfg, grants } = engine()
    const client = clientReturning({ decision: { action: 'allow', raw: {} } })
    const resolved = await resolveDecision({ config: cfg, client, grants }, input)
    expect(resolved.reason.length).toBeGreaterThan(0)
  })
})
