/**
 * The `tools/pre-execute` gate.
 *
 * This is the interception point named in the design: it runs before every tool
 * body, may allow, deny, cancel, or ask, and its return value is what the
 * registry acts on. The gate resolves a verdict, records it, and maps it onto
 * the registry's decision vocabulary.
 *
 * Two properties are load-bearing:
 *
 * - The listener never throws. A throwing listener turns into an error result
 *   that the model reads as a tool failure, which is indistinguishable from a
 *   policy deny and therefore useless as a signal. Every failure path resolves a
 *   verdict instead.
 * - An `ask` that no one can answer resolves to a deny. The registry already
 *   fails closed on an unanswerable ask, but the plugin denies explicitly so the
 *   audit record shows the true reason.
 * @module dsh-plugin-agentjail/hooks/pre-tool-use
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config/schema.js'
import type { AgentJailClient } from '../adapter/agentjail-client.js'
import type { GrantStore } from '../security/grants.js'
import type { AuditLog, AuditVerdict, DecisionSource } from '../audit/audit-log.js'
import type { MetricsCollector } from '../governance/metrics.js'
import { resolveDecision, type DecisionAlert, type ResolvedDecision } from '../security/decision.js'
import { createRequestId, toWireId, argumentDigest } from '../utils/request-id.js'
import { toAgentJailError } from '../utils/errors.js'
import type { AgentJailError } from '../utils/errors.js'

/** The identity and directory a call resolves against. */
export interface CallContext {
  sessionId: string
  agentId: string
  cwd: string
}

/** Collaborators the gate needs. */
export interface PreToolUseGateOptions {
  config: Config
  client: AgentJailClient
  grants: GrantStore
  audit: AuditLog
  metrics: MetricsCollector
  /** Emit a structured alert. */
  onAlert?: (alert: DecisionAlert) => void
  /** Read the working directory for a call, when the runtime knows one. */
  cwdFor?: (exec: ToolExecution) => string | undefined
}

/** The gate's public surface. */
export interface PreToolUseGate {
  /**
   * Evaluate one pending call and return the registry decision.
   * @param exec - the pending tool call.
   * @returns the decision to apply.
   */
  evaluate(exec: ToolExecution): Promise<PreToolDecision>
  /**
   * Re-assert the verdict already resolved for a call.
   *
   * Registered as a monotonic guard: a guard has no allow result, so once this
   * returns a reason no later listener can re-open the call. Returns `undefined`
   * when the call was allowed or was never evaluated by this gate.
   * @param exec - the call to re-check.
   * @returns the denial reason, or `undefined`.
   */
  guardReason(exec: ToolExecution): string | undefined
  /**
   * Read the argument digest recorded for a call awaiting an approval decision.
   * @param callId - the exact call being decided.
   * @param toolName - the tool the call targets.
   * @returns the digest, or `undefined` when no matching evaluation is recorded.
   */
  digestForApproval(callId: string, toolName: string): string | undefined
}

/**
 * Read the session and agent identity from an execution.
 *
 * A call outside an agent has no session; the plugin reports a synthetic
 * `unscoped` session rather than an empty string, so audit records group
 * correctly and per-session overrides stay unambiguous.
 * @param exec - the pending tool call.
 * @returns the call identity.
 */
export function callContext(exec: ToolExecution, fallbackCwd: string): CallContext {
  const agent = exec.agent
  const sessionId = agent?.id ?? 'unscoped'
  const headerCwd = agent?.session?.header?.cwd
  return {
    sessionId: String(sessionId),
    agentId: String(sessionId),
    cwd: headerCwd ?? fallbackCwd,
  }
}

/**
 * Build the `tools/pre-execute` listener.
 * @param ctx - the plugin's context, used for logging.
 * @param options - the gate's collaborators.
 * @returns the gate, whose `evaluate` is the listener body.
 */
export function createPreToolUseGate(ctx: Context, options: PreToolUseGateOptions): PreToolUseGate {
  const { config } = options
  /** Denial reasons resolved for calls in flight, read back by the monotonic guard. */
  const denials = new WeakMap<ToolExecution, string>()
  /** Argument digests of calls awaiting an approval decision, keyed by call id. */
  const pendingApprovals = new Map<string, { toolName: string; digest: string }>()

  const record = async (
    exec: ToolExecution,
    identity: CallContext,
    resolved: ResolvedDecision,
    digest: string,
    durationMs: number,
    monitorOnly: boolean,
  ): Promise<void> => {
    await options.audit.record({
      requestId: toWireId(createRequestId(), exec.name),
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      toolName: exec.name,
      jailToolName: exec.name,
      cwd: identity.cwd,
      verdict: resolved.verdict,
      source: resolved.source,
      arguments: exec.arguments,
      digest,
      durationMs,
      ...(resolved.ruleId !== undefined ? { ruleId: resolved.ruleId } : {}),
      ...(resolved.reason.length > 0 ? { reason: resolved.reason } : {}),
      ...(resolved.impact !== undefined ? { impact: resolved.impact } : {}),
      ...(resolved.wouldAction !== undefined ? { wouldAction: resolved.wouldAction } : {}),
      ...(resolved.grantId !== undefined ? { grantId: resolved.grantId } : {}),
      ...(resolved.error !== undefined
        ? { errorCode: resolved.error.code, errorMessage: resolved.error.message }
        : {}),
      ...(monitorOnly ? { monitorOnly: true } : {}),
    })
    options.metrics.observe({
      at: Date.now(),
      verdict: resolved.verdict,
      source: resolved.source,
      toolName: exec.name,
      sessionId: identity.sessionId,
      durationMs,
    })
  }

  return {
    async evaluate(exec: ToolExecution): Promise<PreToolDecision> {
      const startedAt = Date.now()
      const identity = callContext(exec, config.policyContext.attributes['cwd'] ?? process.cwd())
      const digest = digestArguments(exec.arguments)
      let resolved: ResolvedDecision
      try {
        resolved = await resolveDecision(
          {
            config,
            client: options.client,
            grants: options.grants,
            ...(options.onAlert !== undefined ? { onAlert: options.onAlert } : {}),
          },
          {
            toolName: exec.name,
            sessionId: identity.sessionId,
            agentId: identity.agentId,
            digest,
            arguments: asRecord(exec.arguments),
            ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
          },
        )
      } catch (error) {
        resolved = failureResolution(toAgentJailError(error), config)
      }

      const monitorOnly = config.enforcement === 'monitor'
      try {
        await record(exec, identity, resolved, digest, Date.now() - startedAt, monitorOnly)
      } catch (error) {
        ctx.logger?.warn?.('agentjail: failed to write an audit record: %s', errorMessage(error))
      }

      const decision = toPreToolDecision(resolved)
      // Monitor mode blocks nothing, so it must not arm the monotonic guard
      // either: the guard has no allow result, so an armed denial would defeat
      // the monitor.
      if (!monitorOnly && decision.kind === 'deny') {
        denials.set(exec, decision.reason)
      }
      if (decision.kind === 'ask' && exec.callId !== undefined) {
        pendingApprovals.set(exec.callId, { toolName: exec.name, digest })
        if (pendingApprovals.size > 1024) {
          const oldest = pendingApprovals.keys().next()
          if (oldest.done !== true) pendingApprovals.delete(oldest.value)
        }
      }

      if (monitorOnly && resolved.verdict !== 'allow') {
        ctx.logger?.info?.(
          'agentjail (monitor): would have %s "%s" — %s',
          resolved.verdict,
          exec.name,
          resolved.reason,
        )
        return { kind: 'allow' }
      }

      return decision
    },

    guardReason(exec: ToolExecution): string | undefined {
      return denials.get(exec)
    },

    digestForApproval(callId: string, toolName: string): string | undefined {
      const entry = pendingApprovals.get(callId)
      if (entry === undefined || entry.toolName !== toolName) return undefined
      return entry.digest
    },
  }
}

/** Map a resolved verdict onto the registry's decision vocabulary. */
export function toPreToolDecision(resolved: ResolvedDecision): PreToolDecision {
  switch (resolved.verdict) {
    case 'allow':
      return { kind: 'allow' }
    case 'ask':
      return {
        kind: 'ask',
        reason: resolved.reason,
        displayReason: { en: resolved.reason },
      }
    case 'deny':
      return {
        kind: 'deny',
        reason: formatDenial(resolved),
        info: {
          name: 'AgentJailPolicyError',
          code: resolved.ruleId ?? 'AGENTJAIL_DENIED',
        },
      }
  }
}

/**
 * Render a denial reason for the model and the user.
 *
 * The rule id and impact are included because a model that understands why a
 * call was blocked can choose a different approach instead of retrying.
 * @param resolved - the resolved denial.
 * @returns the model-facing reason.
 */
export function formatDenial(resolved: ResolvedDecision): string {
  const parts = [`Blocked by AgentJail policy: ${resolved.reason}`]
  if (resolved.ruleId !== undefined) parts.push(`rule: ${resolved.ruleId}`)
  if (resolved.impact !== undefined) parts.push(`impact: ${resolved.impact}`)
  parts.push(`source: ${resolved.source}`)
  return parts.join(' — ')
}

/** Build a verdict from an unexpected resolver failure. */
function failureResolution(error: AgentJailError, config: Config): ResolvedDecision {
  const verdict: AuditVerdict = config.failureAction
  const source: DecisionSource = 'failure-action'
  return {
    verdict,
    source,
    reason: `AgentJail policy evaluation failed (${error.code}: ${error.message}); applying the configured failure action "${verdict}"`,
    error,
  }
}

/** Narrow unknown arguments into a record without copying them. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { value }
}

/** Digest the exact arguments a verdict is bound to. */
function digestArguments(value: unknown): string {
  return argumentDigest(value)
}

/** Extract a printable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
