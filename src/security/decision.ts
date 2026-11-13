/**
 * Verdict resolution.
 *
 * This module turns one tool call plus the configured policy into exactly one
 * verdict, in a fixed order that cannot be reordered by configuration:
 *
 * 1. Exemptions — an explicit bypass, recorded as such.
 * 2. Scope overrides — agent, then session, then tool.
 * 3. Outstanding grants — a previously approved call identity.
 * 4. The AgentJail engine — the authoritative OPA/Rego verdict.
 * 5. The default action — when the engine matched no rule, so it returned a bare
 *    `allow` with no `rule_id` rather than a verdict.
 * 6. The failure action — when no trusted answer was available at all.
 *
 * The order matters: an exemption is the only path that bypasses the engine, and
 * a failure can only ever reach step 6. That is what makes "unreachable engine"
 * structurally unable to become an allow.
 * @module dsh-plugin-agentjail/security/decision
 */

import type { Config, ScopeOverride } from '../config/schema.js'
import type { AgentJailClient, EvaluateOutcome } from '../adapter/agentjail-client.js'
import type { PolicyDecision } from '../adapter/protocol.js'
import type { GrantStore, GrantScope } from './grants.js'
import type { AuditVerdict, DecisionSource } from '../audit/audit-log.js'
import type { NormalizedRequest } from './normalizer.js'
import type { AgentJailError } from '../utils/errors.js'

/** The verdict the plugin applies, plus why it was reached. */
export interface ResolvedDecision {
  /** Verdict to apply to the tool pipeline. */
  verdict: AuditVerdict
  /** What produced the verdict. */
  source: DecisionSource
  /** Human-readable justification suitable for the model and the audit log. */
  reason: string
  /** Rule that produced the verdict, when the engine named one. */
  ruleId?: string
  /** Consequence-of-allowing text, when the engine supplied one. */
  impact?: string
  /** Verdict the daemon declined to act on because it is monitoring. */
  wouldAction?: string
  /** Identifier of the grant that authorized the call, when one was reused. */
  grantId?: string
  /** Transport or protocol failure, when the verdict came from a failure action. */
  error?: AgentJailError
}

/** Everything the resolver needs to decide one call. */
export interface ResolveInput {
  /** The Harness tool name as registered. */
  toolName: string
  /** Session the call belongs to. */
  sessionId: string
  /** Agent the call belongs to. */
  agentId: string
  /** Digest binding the verdict to the exact arguments. */
  digest: string
  /** Raw arguments, for audit retention. */
  arguments: Record<string, unknown>
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** The resolver's collaborators. */
export interface DecisionEngineOptions {
  config: Config
  client: AgentJailClient
  grants: GrantStore
  /** Emit a structured alert; used by the governance layer. */
  onAlert?: (alert: DecisionAlert) => void
}

/** A structured security alert. */
export interface DecisionAlert {
  /** Alert kind. */
  kind: 'denied' | 'asked' | 'engine-unavailable' | 'deny-rate'
  /** Tool the alert is about. */
  toolName: string
  /** Session the alert is about. */
  sessionId: string
  /** Human-readable alert message. */
  message: string
  /** Rule that produced the alert, when known. */
  ruleId?: string
  /** Error code, when the alert reports a failure. */
  errorCode?: string
}

/**
 * Report whether a tool bypasses policy evaluation by configuration.
 * @param config - the plugin configuration.
 * @param toolName - the Harness tool name.
 * @returns the matching exemption description, or `undefined`.
 */
export function matchExemption(config: Config, toolName: string): string | undefined {
  if (config.exemptTools.includes(toolName)) return `exemptTools:${toolName}`
  const prefix = config.exemptToolPrefixes.find(
    (candidate) => candidate.length > 0 && toolName.startsWith(candidate),
  )
  return prefix === undefined ? undefined : `exemptToolPrefixes:${prefix}`
}

/**
 * Select the most specific configured override for one call.
 *
 * Precedence is agent, then session, then tool: the narrower the scope, the
 * more specific the operator's intent.
 * @param config - the plugin configuration.
 * @param input - the call identity.
 * @returns the matching override, or `undefined`.
 */
export function matchOverride(
  config: Config,
  input: { agentId: string; sessionId: string; toolName: string },
): ScopeOverride | undefined {
  return (
    config.overrides.agents[input.agentId] ??
    config.overrides.sessions[input.sessionId] ??
    config.overrides.tools[input.toolName]
  )
}

/**
 * Apply the configured action mapping to an engine action.
 *
 * `ask` is mapped through `askAction`, so a deployment that cannot answer
 * approval prompts can turn every ask into a deny without touching the policy.
 * @param config - the plugin configuration.
 * @param action - the engine's action.
 * @returns the verdict to apply.
 */
export function mapEngineAction(config: Config, action: 'allow' | 'deny' | 'ask'): AuditVerdict {
  if (action === 'ask') return config.askAction
  return action
}

/**
 * Apply the configured action mapping to the failure action.
 * @param config - the plugin configuration.
 * @returns the verdict to apply when no trusted answer is available.
 */
export function failureVerdict(config: Config): AuditVerdict {
  return config.failureAction
}

/**
 * Resolve a plugin-level `ask` against `askFallback`.
 *
 * `native` keeps the ask so the Harness approval service can prompt a human;
 * `deny` converts it to a denial here, without prompting, for a deployment that
 * has no way to answer — a headless CI job, for example. An engine `ask` already
 * passed through `askAction`, so this only ever sees an ask the deployment chose
 * to surface.
 * @param config - the plugin configuration.
 * @param resolved - the verdict resolved so far.
 * @returns the verdict to apply, with `ask` resolved through the fallback.
 */
export function applyAskFallback(config: Config, resolved: ResolvedDecision): ResolvedDecision {
  if (resolved.verdict !== 'ask' || config.askFallback !== 'deny') return resolved
  return {
    ...resolved,
    verdict: 'deny',
    reason: `${resolved.reason} (askFallback is "deny", so the prompt is not surfaced)`,
  }
}

/**
 * Resolve one tool call into exactly one verdict.
 *
 * Resolving is side-effect free apart from consuming a grant, which is why it is
 * separated from applying the verdict: a monitor-mode deployment resolves
 * verdicts it will not enforce.
 * @param options - the resolver's collaborators.
 * @param input - the call to decide.
 * @returns the resolved verdict.
 */
export async function resolveDecision(
  options: DecisionEngineOptions,
  input: ResolveInput,
): Promise<ResolvedDecision> {
  const { config, client, grants } = options

  const exemption = matchExemption(config, input.toolName)
  if (exemption !== undefined) {
    return {
      verdict: 'allow',
      source: 'exempt',
      reason: `tool "${input.toolName}" bypasses policy by configuration (${exemption})`,
    }
  }

  const override = matchOverride(config, input)
  if (override !== undefined) {
    return applyAskFallback(config, {
      verdict: override.action,
      source: 'override',
      reason: override.reason ?? `configuration overrides the verdict for "${input.toolName}"`,
    })
  }

  if (config.approval.grantsEnabled) {
    const consumption = grants.consume({
      toolName: input.toolName,
      sessionId: input.sessionId,
      digest: input.digest,
    })
    if (consumption.kind === 'granted') {
      return {
        verdict: 'allow',
        source: 'grant',
        reason: consumption.grant.reason ?? `reusing an approval for "${input.toolName}"`,
        grantId: consumption.grant.id,
      }
    }
  }

  const outcome = await client.evaluateCall(
    {
      toolName: input.toolName,
      arguments: input.arguments,
      sessionId: input.sessionId,
      cwd: resolveCwd(config),
    },
    input.signal,
  )

  return applyAskFallback(config, fromOutcome(options, outcome))
}

/** Derive the working directory reported to the engine from configuration. */
function resolveCwd(config: Config): string {
  const configured = config.policyContext.attributes['cwd']
  return configured ?? process.cwd()
}

/**
 * Report whether a decision is the engine's no-match default rather than a
 * rule's verdict.
 *
 * AgentJail's own default decision is `{"action": "allow"}` with no `rule_id`
 * (`agentpolicy/policies/default.rego`), and the generated entrypoint this plugin
 * ships behaves the same way: it names a `rule_id` whenever a rule matched and
 * emits a bare `allow` when none did. An `allow` with no rule behind it is
 * therefore the engine reporting "no rule matched", which is exactly the case
 * `defaultAction` governs. That fallback cannot live in the policy itself, since
 * a rule author cannot see this plugin's configuration.
 *
 * The daemon's own resolver labels a synthesized default `resolver/default`, and
 * its hook treats that id as "not a real rule", so it counts as a no-match too.
 *
 * A `would_action` means a rule matched and the daemon declined to enforce it
 * because it is monitoring, so that is a rule verdict, not a no-match.
 * @param decision - the engine's decision.
 * @returns whether the engine matched no rule.
 */
export function isNoRuleMatch(decision: PolicyDecision): boolean {
  if (decision.action !== 'allow' || decision.wouldAction !== undefined) return false
  return decision.ruleId === undefined || decision.ruleId === DEFAULT_RULE_ID
}

/** Rule id the daemon's resolver attaches to a decision no rule produced. */
const DEFAULT_RULE_ID = 'resolver/default'

/** Fold a client outcome into a verdict. */
function fromOutcome(options: DecisionEngineOptions, outcome: EvaluateOutcome): ResolvedDecision {
  const { config } = options
  if (outcome.decision === undefined) {
    const error = outcome.error
    const verdict = failureVerdict(config)
    const detail =
      error === undefined
        ? 'no decision and no error were reported'
        : `${error.code}: ${error.message}`
    const resolved: ResolvedDecision = {
      verdict,
      source: 'failure-action',
      reason: `AgentJail policy engine unavailable; applying the configured failure action "${verdict}" (${detail})`,
      ...(error !== undefined ? { error } : {}),
    }
    options.onAlert?.({
      kind: 'engine-unavailable',
      toolName: outcome.request.harnessToolName,
      sessionId: outcome.request.sessionId,
      message: resolved.reason,
      ...(error !== undefined ? { errorCode: error.code } : {}),
    })
    return resolved
  }

  const decision = outcome.decision
  // The engine matched no rule. Its own `allow` is a placeholder, not a verdict:
  // the operator's configured default decides. Applying it here rather than in
  // the policy keeps the two concepts apart — `failureAction` means "I do not
  // know", `defaultAction` means "no rule matched" — and it is the only place the
  // plugin can see this deployment's configuration.
  let resolved: ResolvedDecision
  if (isNoRuleMatch(decision)) {
    resolved = {
      verdict: config.defaultAction,
      source: 'default',
      reason: `AgentJail policy matched no rule for "${outcome.request.harnessToolName}"; applying the configured default action "${config.defaultAction}"`,
    }
  } else {
    const verdict = mapEngineAction(config, decision.action)
    resolved = {
      verdict,
      source: outcome.cached ? 'cache' : 'engine',
      reason: decision.reason ?? defaultReason(verdict, decision.action),
      ...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
      ...(decision.impact !== undefined ? { impact: decision.impact } : {}),
      ...(decision.wouldAction !== undefined ? { wouldAction: decision.wouldAction } : {}),
    }
  }

  // `askFallback` is applied before the alert is chosen, so a deployment that
  // fails closed on asks reports a denial rather than an ask no one will answer.
  const final = applyAskFallback(config, resolved)
  if (final.verdict === 'deny') {
    options.onAlert?.({
      kind: 'denied',
      toolName: outcome.request.harnessToolName,
      sessionId: outcome.request.sessionId,
      message: final.reason,
      ...(final.ruleId !== undefined ? { ruleId: final.ruleId } : {}),
    })
  } else if (final.verdict === 'ask') {
    options.onAlert?.({
      kind: 'asked',
      toolName: outcome.request.harnessToolName,
      sessionId: outcome.request.sessionId,
      message: final.reason,
      ...(final.ruleId !== undefined ? { ruleId: final.ruleId } : {}),
    })
  }
  return final
}

/** Build a reason when the engine supplied none. */
function defaultReason(verdict: AuditVerdict, engineAction: 'allow' | 'deny' | 'ask'): string {
  if (verdict !== engineAction) {
    return `AgentJail returned "${engineAction}"; configuration maps it to "${verdict}"`
  }
  if (verdict === 'allow') return 'AgentJail policy allows this call'
  if (engineAction === 'ask') return 'AgentJail policy asks for approval of this call'
  return `AgentJail policy returned "${engineAction}"`
}

/**
 * Report whether a resolved verdict should be applied or only recorded.
 * @param config - the plugin configuration.
 * @returns whether verdicts are enforced.
 */
export function isEnforcing(config: Config): boolean {
  return config.enforcement === 'enforce'
}

/**
 * Choose the grant lifetime implied by an approval.
 * @param config - the plugin configuration.
 * @returns the grant scope to issue, or `undefined` when grants are disabled.
 */
export function grantScopeForApproval(config: Config): GrantScope | undefined {
  return config.approval.grantsEnabled ? 'once' : undefined
}

export type { NormalizedRequest }
