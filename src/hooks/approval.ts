/**
 * The approval answerer.
 *
 * When the gate resolves an `ask`, the registry hands the question to
 * `ctx.approval`, which walks the answerer chain. This plugin registers one
 * answerer so an approved call is remembered: without it, the same command
 * would be re-approved on every invocation, which trains operators to approve
 * without reading.
 *
 * The answerer is deliberately narrow. It grants only for the exact session,
 * tool, and argument digest the question is about, and it records the grant so
 * the next evaluation of that identical call short-circuits at the grant stage
 * instead of reaching the daemon. It never widens an ask into an allow for a
 * different call.
 * @module dsh-plugin-agentjail/hooks/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Config } from '../config/schema.js'
import type { GrantStore } from '../security/grants.js'
import type { AuditLog } from '../audit/audit-log.js'
import type { DecisionAlert } from '../security/decision.js'

/** Collaborators the approval answerer needs. */
export interface ApprovalHookOptions {
  config: Config
  grants: GrantStore
  audit: AuditLog
  /** Emit a structured alert. */
  onAlert?: (alert: DecisionAlert) => void
  /**
   * Digest the arguments of a call, so the grant binds to exactly what was
   * approved. Supplied by the plugin so the binding matches the gate's own.
   */
  digestFor: (event: ApprovalRequest) => string | undefined
}

/** The registered approval answerer. */
export interface ApprovalHook {
  /**
   * Answer one approval request.
   * @param event - the pending approval request.
   * @param next - delegate to the next answerer.
   * @returns the outcome the registry acts on.
   */
  answer(event: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
}

/**
 * Build the approval answerer.
 *
 * The answerer runs *after* the interactive chain when one is composed: it calls
 * `next()` and only converts an `allowed-once` outcome into a durable grant.
 * Delegating first means an operator's explicit rejection is never overridden by
 * a remembered approval, and a headless deployment with no answerer still fails
 * closed through the chain's `unavailable` outcome.
 * @param ctx - the plugin's context, used for logging.
 * @param options - the answerer's collaborators.
 * @returns the answerer.
 */
export function createApprovalHook(ctx: Context, options: ApprovalHookOptions): ApprovalHook {
  const { config, grants } = options

  return {
    async answer(
      event: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome> {
      const outcome = await next()
      if (outcome !== 'allowed-once') return outcome
      if (!config.approval.grantsEnabled) return outcome

      const digest = options.digestFor(event)
      if (digest === undefined) return outcome

      const sessionId = String(event.agent.id)
      const grant = grants.issue({
        scope: 'once',
        toolName: event.toolName,
        sessionId,
        digest,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      })
      try {
        await options.audit.record({
          requestId: grant.id,
          sessionId,
          agentId: sessionId,
          toolName: event.toolName,
          jailToolName: event.toolName,
          cwd: config.policyContext.attributes['cwd'] ?? process.cwd(),
          verdict: 'allow',
          source: 'grant',
          arguments: {},
          digest,
          durationMs: 0,
          reason: `approval granted for "${event.toolName}"; the next identical call will not be re-prompted`,
          grantId: grant.id,
        })
      } catch (error) {
        ctx.logger?.warn?.('agentjail: failed to record an approval: %s', errorMessage(error))
      }
      options.onAlert?.({
        kind: 'asked',
        toolName: event.toolName,
        sessionId,
        message: `approval granted for "${event.toolName}"`,
      })
      return outcome
    },
  }
}

/** Extract a printable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
