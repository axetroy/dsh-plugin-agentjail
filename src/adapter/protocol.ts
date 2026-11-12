/**
 * AgentJail daemon wire codec.
 *
 * The daemon speaks newline-delimited JSON over a Unix domain socket: one JSON
 * object per line, `\n` terminated. A policy-evaluation request carries
 * `hook_event`, `tool_name`, `tool_input`, `session_id`, and `cwd`; the reply
 * carries `action`, `reason`, and `rule_id`.
 *
 * This module owns both directions of that contract and nothing else, so the
 * framing rules can be tested without a socket and the transport can be tested
 * without re-deriving them.
 * @module dsh-plugin-agentjail/adapter/protocol
 */

import { ProtocolError, RequestTooLargeError } from '../utils/errors.js'

/** Actions AgentJail may return in a policy decision. */
export type PolicyAction = 'allow' | 'ask' | 'deny'

/** Every action the codec accepts from the daemon. */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

/** Control-plane discriminator, mirroring the daemon's `wire.ControlType`. */
export const CONTROL_TYPE = 'control'

/** Control operation: reload `policy.yaml` and the Rego bundle in place. */
export const CONTROL_OP_RELOAD = 'reload'

/** Control operation: side-effect-free liveness probe. */
export const CONTROL_OP_PING = 'ping'

/** A control-plane request frame. */
export interface ControlRequest {
  type: typeof CONTROL_TYPE
  op: typeof CONTROL_OP_PING | typeof CONTROL_OP_RELOAD
}

/** A control-plane response frame. */
export interface ControlResponse {
  ok: boolean
  error?: string
  version?: string
}

/**
 * A policy-evaluation request frame.
 *
 * Field names and nullability mirror the daemon's Go struct tags exactly; a
 * renamed field would silently degrade every rule to the engine's default.
 */
export interface PolicyRequestFrame {
  id: string
  hook_event: string
  tool_name: string
  tool_input: Record<string, unknown>
  session_id: string
  cwd: string
  agent?: string
  agent_pid?: number
  permission_mode?: string
  turn_id?: string
  tool_use_id?: string
  capabilities?: string[]
}

/** A policy-evaluation response frame, including the daemon's optional diagnostics. */
export interface PolicyResponseFrame {
  id?: string
  action?: string
  reason?: string
  rule_id?: string
  impact?: string
  would_action?: string
  policy_action?: string
  effective_action?: string
  adapter?: string
  translation_reason?: string
  defer_to_native_permission?: boolean
  approval_challenge?: string
  approval_operation?: string
  approval_display?: string
  approval_reason?: string
}

/** A validated policy decision. */
export interface PolicyDecision {
  /** The enforced action. */
  action: PolicyAction
  /** Rule that produced the action, when the engine names one. */
  ruleId?: string
  /** Human-readable justification, when the engine supplies one. */
  reason?: string
  /** Consequence-of-allowing text, when a rule populates it. */
  impact?: string
  /**
   * Verdict the daemon declined to act on because it is in monitor mode.
   * Present only when the daemon is monitoring; `action` remains authoritative.
   */
  wouldAction?: PolicyAction
  /** The raw response frame, retained for audit. */
  raw: PolicyResponseFrame
}

/** Result of a successful control-plane round trip. */
export interface ControlResult {
  ok: boolean
  error?: string
  version?: string
}

/**
 * Serialize a request frame into a newline-terminated wire line.
 * @param frame - the frame to encode.
 * @param maxBytes - maximum permitted byte length of the encoded line.
 * @returns the encoded line, including its trailing newline.
 * @throws RequestTooLargeError when the encoded frame exceeds `maxBytes`.
 */
export function encodeRequest(
  frame: PolicyRequestFrame | ControlRequest,
  maxBytes: number,
): string {
  const line = `${JSON.stringify(frame)}\n`
  const size = Buffer.byteLength(line, 'utf8')
  if (size > maxBytes) throw new RequestTooLargeError(size, maxBytes)
  return line
}

/**
 * Parse one response line into a JSON object.
 * @param line - a single line without its trailing newline.
 * @returns the parsed frame.
 * @throws ProtocolError when the line is not a JSON object.
 */
export function decodeFrame(line: string): Record<string, unknown> {
  const trimmed = line.trim()
  if (trimmed.length === 0) throw new ProtocolError('daemon returned an empty response line')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ProtocolError(`daemon response is not valid JSON: ${trimmed.slice(0, 200)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProtocolError('daemon response is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Narrow an arbitrary string to a known policy action.
 * @param value - the candidate action.
 * @returns the action when recognized, else `undefined`.
 */
export function asPolicyAction(value: unknown): PolicyAction | undefined {
  return typeof value === 'string' && KNOWN_ACTIONS.has(value) ? (value as PolicyAction) : undefined
}

/** Read an optional string field, ignoring non-string values. */
function optionalString(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate a policy response frame into a decision.
 *
 * A frame whose `action` is missing or unrecognized is rejected rather than
 * defaulted: an unrecognized action means the daemon's contract changed, and
 * guessing at that boundary is exactly the failure this plugin exists to
 * prevent. The caller converts the rejection into the configured failure action.
 * @param frame - the decoded response frame.
 * @returns the validated decision.
 * @throws ProtocolError when `action` is missing or unrecognized.
 */
export function toPolicyDecision(frame: Record<string, unknown>): PolicyDecision {
  const action = asPolicyAction(frame['action'])
  if (action === undefined) {
    const observed = frame['action']
    throw new ProtocolError(
      `daemon response carried no recognizable action (action=${JSON.stringify(observed)})`,
    )
  }
  const decision: PolicyDecision = { action, raw: frame }
  const ruleId = optionalString(frame, 'rule_id')
  const reason = optionalString(frame, 'reason')
  const impact = optionalString(frame, 'impact')
  const wouldAction = asPolicyAction(frame['would_action'])
  if (ruleId !== undefined) decision.ruleId = ruleId
  if (reason !== undefined) decision.reason = reason
  if (impact !== undefined) decision.impact = impact
  if (wouldAction !== undefined) decision.wouldAction = wouldAction
  return decision
}

/**
 * Validate a control response frame.
 * @param frame - the decoded response frame.
 * @returns the normalized control result.
 * @throws ProtocolError when the `ok` field is absent or not boolean.
 */
export function toControlResult(frame: Record<string, unknown>): ControlResult {
  const ok = frame['ok']
  if (typeof ok !== 'boolean') {
    throw new ProtocolError('daemon control response carried no boolean "ok" field')
  }
  const result: ControlResult = { ok }
  const error = optionalString(frame, 'error')
  const version = optionalString(frame, 'version')
  if (error !== undefined) result.error = error
  if (version !== undefined) result.version = version
  return result
}

/**
 * Split a byte stream into complete newline-delimited lines.
 *
 * A partial trailing line stays buffered until its terminator arrives, so a
 * response split across TCP reads is reassembled rather than rejected.
 */
export class LineDecoder {
  private buffer = ''

  /**
   * Feed a chunk and drain every complete line it completes.
   * @param chunk - the newly received text.
   * @returns the complete lines, without terminators.
   */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      lines.push(this.buffer.slice(0, newlineIndex))
      this.buffer = this.buffer.slice(newlineIndex + 1)
      newlineIndex = this.buffer.indexOf('\n')
    }
    return lines
  }

  /**
   * Return any buffered bytes that never received a terminator.
   * @returns the unterminated remainder.
   */
  remainder(): string {
    return this.buffer
  }

  /** Discard buffered bytes, e.g. when a connection is discarded. */
  reset(): void {
    this.buffer = ''
  }
}
