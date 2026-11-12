/**
 * The `tools/post-execute` observer.
 *
 * Pre-execute records the verdict; post-execute records what actually happened.
 * The pair is what lets an operator distinguish "the policy denied this" from
 * "the policy allowed it and the sandbox still stopped it" — a distinction that
 * matters when tuning rules, because a rule that never fires because the OS
 * sandbox already blocks the operation is not the rule doing the work.
 *
 * The listener never changes a result. It is an observer, and an observer that
 * can rewrite outcomes would be a second, hidden policy engine.
 * @module dsh-plugin-agentjail/hooks/post-tool-use
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config/schema.js'
import type { AuditLog } from '../audit/audit-log.js'
import { argumentDigest } from '../utils/request-id.js'

/** Collaborators the observer needs. */
export interface PostToolUseOptions {
  config: Config
  audit: AuditLog
}

/** Signatures the OS sandbox leaves in a failed tool result. */
const SANDBOX_DENIAL_SIGNATURES: readonly RegExp[] = [
  /operation not permitted/i,
  /permission denied/i,
  /EPERM/,
  /EACCES/,
  /read-only file system/i,
]

/** The observer's public surface. */
export interface PostToolUseObserver {
  /**
   * Observe one completed call.
   * @param exec - the call that just ran.
   * @param result - the result it produced.
   */
  observe(exec: ToolExecution, result: Readonly<ToolExecutionResult>): void
}

/**
 * Report whether a failed result carries an OS sandbox denial signature.
 *
 * The plugin never treats this as a policy verdict; it records it so an operator
 * can see that a call was stopped below the policy layer.
 * @param result - the completed call's result.
 * @returns whether the failure looks like a sandbox denial.
 */
export function looksLikeSandboxDenial(result: Readonly<ToolExecutionResult>): boolean {
  if (!result.isError) return false
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  return SANDBOX_DENIAL_SIGNATURES.some((pattern) => pattern.test(text))
}

/**
 * Build the `tools/post-execute` observer.
 * @param ctx - the plugin's context, used for logging.
 * @param options - the observer's collaborators.
 * @returns the observer.
 */
export function createPostToolUseObserver(
  ctx: Context,
  options: PostToolUseOptions,
): PostToolUseObserver {
  const { config, audit } = options

  return {
    observe(exec: ToolExecution, result: Readonly<ToolExecutionResult>): void {
      // Only sandbox-signature failures are recorded here. A policy denial is
      // already recorded by the gate, and a generic tool error is the tool's own
      // failure rather than a security event; recording either would duplicate
      // the gate's record without adding a signal.
      if (!looksLikeSandboxDenial(result)) return

      const sessionId = exec.agent?.id === undefined ? 'unscoped' : String(exec.agent.id)
      const digest = argumentDigest(exec.arguments)
      void audit
        .record({
          requestId: `outcome-${digest}`,
          sessionId,
          agentId: sessionId,
          toolName: exec.name,
          jailToolName: exec.name,
          cwd:
            exec.agent?.session?.header?.cwd ??
            config.policyContext.attributes['cwd'] ??
            process.cwd(),
          verdict: 'allow',
          source: 'engine',
          arguments: exec.arguments,
          digest,
          durationMs: 0,
          reason: 'tool call failed with an OS sandbox denial signature',
          errorCode: 'SANDBOX_DENIED',
        })
        .catch((error: unknown) => {
          ctx.logger?.warn?.('agentjail: failed to record a tool outcome: %s', errorMessage(error))
        })
    },
  }
}

/** Extract a printable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
