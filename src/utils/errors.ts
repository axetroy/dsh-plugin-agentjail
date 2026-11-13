/**
 * Typed error taxonomy for the plugin.
 *
 * Every failure carries a stable `code` so policy decisions, audit records, and
 * callers can distinguish a genuine deny from a transport failure. Failures
 * never collapse into an allow.
 * @module dsh-plugin-agentjail/utils/errors
 */

/** Stable error codes emitted by the plugin. */
export const ErrorCode = {
  /** The plugin is not configured with a usable policy endpoint. */
  NOT_CONFIGURED: 'AGENTJAIL_NOT_CONFIGURED',
  /** The AgentJail daemon socket could not be reached. */
  DAEMON_UNAVAILABLE: 'AGENTJAIL_DAEMON_UNAVAILABLE',
  /** The daemon did not answer inside the configured budget. */
  TIMEOUT: 'AGENTJAIL_TIMEOUT',
  /** The daemon answered with bytes that are not a valid v1 response frame. */
  PROTOCOL: 'AGENTJAIL_PROTOCOL_ERROR',
  /** The serialized request exceeded the configured size limit. */
  REQUEST_TOO_LARGE: 'AGENTJAIL_REQUEST_TOO_LARGE',
  /** The caller's signal aborted before a verdict was available. */
  ABORTED: 'AGENTJAIL_ABORTED',
  /** The audit sink could not persist a record. */
  AUDIT_WRITE_FAILED: 'AGENTJAIL_AUDIT_WRITE_FAILED',
  /** An approval was requested but no answerer is reachable. */
  APPROVAL_UNAVAILABLE: 'AGENTJAIL_APPROVAL_UNAVAILABLE',
  /** The plugin itself was configured with an invalid value. */
  INVALID_CONFIG: 'AGENTJAIL_INVALID_CONFIG',
} as const

/** Union of every error code the plugin may raise. */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Base class for every error the plugin raises. */
export class AgentJailError extends Error {
  /** Stable machine-readable identity for this failure. */
  readonly code: ErrorCodeValue

  /**
   * @param message - human-readable description of the failure.
   * @param code - stable machine-readable identity.
   * @param options - standard `Error` options (e.g. `cause`).
   */
  constructor(message: string, code: ErrorCodeValue, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentJailError'
    this.code = code
  }
}

/** The daemon socket could not be reached or the connection dropped mid-request. */
export class DaemonUnavailableError extends AgentJailError {
  /**
   * @param message - description of the connection failure.
   * @param options - standard `Error` options (e.g. `cause`).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, ErrorCode.DAEMON_UNAVAILABLE, options)
    this.name = 'DaemonUnavailableError'
  }
}

/** The daemon did not answer inside the configured budget. */
export class PolicyTimeoutError extends AgentJailError {
  /**
   * @param timeoutMs - the budget that elapsed.
   */
  constructor(timeoutMs: number) {
    super(`AgentJail policy evaluation exceeded ${timeoutMs}ms`, ErrorCode.TIMEOUT)
    this.name = 'PolicyTimeoutError'
  }
}

/** The daemon answered with an unparseable or out-of-contract frame. */
export class ProtocolError extends AgentJailError {
  /**
   * @param message - description of the contract violation.
   */
  constructor(message: string) {
    super(message, ErrorCode.PROTOCOL)
    this.name = 'ProtocolError'
  }
}

/** The serialized request body exceeded the configured ceiling. */
export class RequestTooLargeError extends AgentJailError {
  /**
   * @param size - serialized byte length.
   * @param limit - configured maximum byte length.
   */
  constructor(size: number, limit: number) {
    super(
      `policy request is ${size} bytes, exceeding the ${limit}-byte limit`,
      ErrorCode.REQUEST_TOO_LARGE,
    )
    this.name = 'RequestTooLargeError'
  }
}

/** The caller's cancellation signal aborted before a verdict was available. */
export class PolicyAbortedError extends AgentJailError {
  /**
   * @param message - description of the cancellation.
   */
  constructor(message = 'policy evaluation aborted by the caller') {
    super(message, ErrorCode.ABORTED)
    this.name = 'PolicyAbortedError'
  }
}

/** No approval answerer is reachable for a call that requires one. */
export class ApprovalUnavailableError extends AgentJailError {
  /**
   * @param message - description of the missing approval channel.
   */
  constructor(message: string) {
    super(message, ErrorCode.APPROVAL_UNAVAILABLE)
    this.name = 'ApprovalUnavailableError'
  }
}

/**
 * Normalize an arbitrary thrown value into an `AgentJailError`.
 *
 * Transport failures surface as `DaemonUnavailableError` so the decision engine
 * can apply the configured failure action instead of leaking an untyped error
 * through the tool pipeline.
 * @param error - the thrown value to normalize.
 * @returns an error carrying a stable code.
 */
export function toAgentJailError(error: unknown): AgentJailError {
  if (error instanceof AgentJailError) return error
  if (error instanceof Error && error.name === 'AbortError')
    return new PolicyAbortedError(error.message)
  if (error instanceof Error) return new DaemonUnavailableError(error.message, { cause: error })
  return new DaemonUnavailableError(String(error), { cause: error })
}
