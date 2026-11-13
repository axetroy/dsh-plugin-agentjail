/**
 * Unit tests for the pre-execute gate, the post-execute observer, and the
 * approval answerer, driven directly rather than through the registry.
 *
 * The integration suite proves the wiring; these prove the branches the wiring
 * reaches only under specific runtime shapes — a call with no agent, a denial
 * with no rule id, an audit sink that throws — which are hard to arrange through
 * a full pipeline.
 * @module tests/unit/hooks
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config } from '../../src/config/schema.js'
import { createPreToolUseGate, formatDenial } from '../../src/hooks/pre-tool-use.js'
import { createPostToolUseObserver, looksLikeSandboxDenial } from '../../src/hooks/post-tool-use.js'
import { createApprovalHook } from '../../src/hooks/approval.js'
import { AuditLog } from '../../src/audit/audit-log.js'
import { MetricsCollector } from '../../src/governance/metrics.js'
import { GrantStore } from '../../src/security/grants.js'
import type { AgentJailClient, EvaluateOutcome } from '../../src/adapter/agentjail-client.js'
import { argumentDigest } from '../../src/utils/request-id.js'

function auditOptions() {
  return {
    enabled: true,
    storage: 'memory' as const,
    filePath: '',
    maxFileBytes: 0,
    maxRotatedFiles: 0,
    redactSensitiveData: true,
    maxValueChars: 100,
  }
}

function metrics(): MetricsCollector {
  return new MetricsCollector({
    windowMs: 10000,
    denyRateAlertThreshold: 0.5,
    denyRateAlertMinSamples: 5,
  })
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

function exec(overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    callId: 'call-1' as never,
    rootCallId: 'call-1' as never,
    token: Symbol('token') as never,
    name: 'bash',
    arguments: { command: 'ls' },
    signal: new AbortController().signal,
    ...overrides,
  } as ToolExecution
}

describe('callContext through the gate', () => {
  it('reports an unscoped session when the call has no agent', async () => {
    const gate = createPreToolUseGate(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      client: clientReturning({ decision: { action: 'allow', ruleId: 'r', raw: {} } }),
      grants: new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 }),
      audit: new AuditLog(auditOptions()),
      metrics: metrics(),
    })
    expect(await gate.evaluate(exec())).toEqual({ kind: 'allow' })
  })

  it('uses the agent session header cwd when the runtime supplies one', async () => {
    const audit = new AuditLog(auditOptions())
    const gate = createPreToolUseGate(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      client: clientReturning({ decision: { action: 'deny', ruleId: 'r', reason: 'no', raw: {} } }),
      grants: new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 }),
      audit,
      metrics: metrics(),
    })
    const agent = { id: 'agent-1', session: { header: { cwd: '/work/dir' } } }
    const decision = await gate.evaluate(exec({ agent: agent as never }))
    expect(decision.kind).toBe('deny')
    expect(audit.query({ sessionId: 'agent-1' })[0]?.cwd).toBe('/work/dir')
  })
})

describe('pre-execute gate branches', () => {
  function gate(options: {
    reply?: Partial<EvaluateOutcome>
    config?: Record<string, unknown>
    audit?: AuditLog
    onAlert?: (alert: { kind: string }) => void
  }) {
    return createPreToolUseGate(new Context(), {
      config: Config({ audit: { storage: 'memory' }, ...options.config } as never),
      client: clientReturning(options.reply ?? { decision: { action: 'deny', raw: {} } }),
      grants: new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 }),
      audit: options.audit ?? new AuditLog(auditOptions()),
      metrics: metrics(),
      ...(options.onAlert !== undefined ? { onAlert: options.onAlert } : {}),
    })
  }

  it('forwards a deny-rate alert raised by the metrics window', async () => {
    // Two denials cross the 0.5 threshold once the window has the minimum count.
    const collector = new MetricsCollector({
      windowMs: 10000,
      denyRateAlertThreshold: 0.5,
      denyRateAlertMinSamples: 2,
    })
    const alerts: Array<{ kind: string }> = []
    const gateInstance = createPreToolUseGate(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      client: clientReturning({ decision: { action: 'deny', ruleId: 'r', reason: 'no', raw: {} } }),
      grants: new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 }),
      audit: new AuditLog(auditOptions()),
      metrics: collector,
      onAlert: (alert) => alerts.push(alert),
    })
    await gateInstance.evaluate(exec())
    await gateInstance.evaluate(exec({ callId: 'call-2' as never }))
    expect(alerts.some((alert) => alert.kind === 'deny-rate')).toBe(true)
  })

  it('records a denial without a rule id or reason', async () => {
    const decision = await gate({}).evaluate(exec())
    expect(decision.kind).toBe('deny')
  })

  it('resolves monitor mode to an allow but records the verdict', async () => {
    const audit = new AuditLog(auditOptions())
    const gateInstance = gate({
      config: { enforcement: 'monitor' },
      audit,
      reply: { decision: { action: 'deny', ruleId: 'r', reason: 'no', raw: {} } },
    })
    expect(await gateInstance.evaluate(exec())).toEqual({ kind: 'allow' })
    expect(audit.query()[0]?.monitorOnly).toBe(true)
  })

  it('arms the monotonic guard for a denial but not in monitor mode', async () => {
    const denied = gate({})
    const pending = exec()
    await denied.evaluate(pending)
    expect(denied.guardReason(pending)).toBeDefined()

    const monitored = gate({ config: { enforcement: 'monitor' } })
    const monitoredCall = exec()
    await monitored.evaluate(monitoredCall)
    expect(monitored.guardReason(monitoredCall)).toBeUndefined()
  })

  it('survives an audit sink that throws, still returning the verdict', async () => {
    const failing = new AuditLog(auditOptions())
    failing.record = async () => {
      throw new Error('audit sink down')
    }
    const decision = await gate({ audit: failing }).evaluate(exec())
    expect(decision.kind).toBe('deny')
  })

  it('resolves a failure action when the resolver itself throws', async () => {
    const throwing = {
      evaluateCall: async () => {
        throw new Error('unexpected')
      },
    } as unknown as AgentJailClient
    const gateInstance = createPreToolUseGate(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      client: throwing,
      grants: new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 }),
      audit: new AuditLog(auditOptions()),
      metrics: metrics(),
    })
    const decision = await gateInstance.evaluate(exec())
    expect(decision.kind).toBe('deny')
  })

  it('records the pending digest of an ask for the exact call', async () => {
    const gateInstance = gate({ reply: { decision: { action: 'ask', reason: 'review', raw: {} } } })
    await gateInstance.evaluate(exec({ callId: 'ask-1' as never }))
    expect(gateInstance.digestForApproval('ask-1', 'bash')).toBe(argumentDigest({ command: 'ls' }))
    expect(gateInstance.digestForApproval('missing', 'bash')).toBeUndefined()
  })

  it('formats a denial with rule and impact when both are present', () => {
    const reason = formatDenial({
      verdict: 'deny',
      source: 'engine',
      reason: 'blocked',
      ruleId: 'no-rm-rf',
      impact: 'destructive',
    })
    expect(reason).toContain('rule: no-rm-rf')
    expect(reason).toContain('impact: destructive')
  })
})

describe('post-execute observer', () => {
  function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
    return {
      isError: true,
      error: { message: 'Operation not permitted' },
      content: [{ type: 'text', text: 'Operation not permitted' }],
      ...overrides,
    } as ToolExecutionResult
  }

  it('reports a sandbox denial only for an error result carrying a signature', () => {
    expect(looksLikeSandboxDenial(result())).toBe(true)
    expect(looksLikeSandboxDenial(result({ isError: false } as never))).toBe(false)
    expect(
      looksLikeSandboxDenial(result({ content: [{ type: 'text', text: 'all good' }] } as never)),
    ).toBe(false)
  })

  it('ignores a non-text content block when scanning for a signature', () => {
    expect(
      looksLikeSandboxDenial(result({ content: [{ type: 'image', data: 'x' } as never] } as never)),
    ).toBe(false)
  })

  it('records an unscoped session and the fallback cwd', () => {
    const audit = new AuditLog(auditOptions())
    const observer = createPostToolUseObserver(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      audit,
    })
    observer.observe(exec(), result())
    expect(audit.query()[0]?.sessionId).toBe('unscoped')
    expect(audit.query()[0]?.errorCode).toBe('SANDBOX_DENIED')
  })

  it('prefers the agent session cwd when present', () => {
    const audit = new AuditLog(auditOptions())
    const observer = createPostToolUseObserver(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      audit,
    })
    const agent = { id: 'agent-9', session: { header: { cwd: '/from/agent' } } }
    observer.observe(exec({ agent: agent as never }), result())
    const record = audit.query({ sessionId: 'agent-9' })[0]
    expect(record?.cwd).toBe('/from/agent')
  })

  it('does nothing when the result is not a sandbox denial', () => {
    const audit = new AuditLog(auditOptions())
    const observer = createPostToolUseObserver(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      audit,
    })
    observer.observe(exec(), result({ isError: false } as never))
    expect(audit.size).toBe(0)
  })
})

describe('approval answerer branches', () => {
  const request = (overrides: Record<string, unknown> = {}) =>
    ({
      agent: { id: 'sess-1' } as never,
      toolName: 'bash',
      callId: 'call-1' as never,
      ...overrides,
    }) as never

  it('passes through when grants are disabled', async () => {
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    const hook = createApprovalHook(new Context(), {
      config: Config({ approval: { grantsEnabled: false }, audit: { storage: 'memory' } } as never),
      grants,
      audit: new AuditLog(auditOptions()),
      digestFor: () => 'd',
    })
    expect(await hook.answer(request(), async () => 'allowed-once')).toBe('allowed-once')
    expect(grants.list()).toHaveLength(0)
  })

  it('issues a grant without a reason when the event has none', async () => {
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    const hook = createApprovalHook(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      grants,
      audit: new AuditLog(auditOptions()),
      digestFor: () => 'digest-1',
    })
    await hook.answer(request(), async () => 'allowed-once')
    const [grant] = grants.list()
    expect(grant?.reason).toBeUndefined()
  })

  it('records the grant reason when the event carries one', async () => {
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    const hook = createApprovalHook(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      grants,
      audit: new AuditLog(auditOptions()),
      digestFor: () => 'digest-1',
    })
    await hook.answer(request({ reason: 'reviewed' }), async () => 'allowed-once')
    expect(grants.list()[0]?.reason).toBe('reviewed')
  })

  it('survives an audit sink that throws while recording a grant', async () => {
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    const failing = new AuditLog(auditOptions())
    failing.record = async () => {
      throw new Error('sink down')
    }
    const hook = createApprovalHook(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      grants,
      audit: failing,
      digestFor: () => 'digest-1',
    })
    expect(await hook.answer(request(), async () => 'allowed-once')).toBe('allowed-once')
    expect(grants.list()).toHaveLength(1)
  })

  it('does not grant when the digest cannot be resolved', async () => {
    const grants = new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000 })
    const hook = createApprovalHook(new Context(), {
      config: Config({ audit: { storage: 'memory' } } as never),
      grants,
      audit: new AuditLog(auditOptions()),
      digestFor: () => undefined,
    })
    await hook.answer(request(), async () => 'allowed-once')
    expect(grants.list()).toHaveLength(0)
  })
})
