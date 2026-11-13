/**
 * High-level AgentJail client.
 *
 * Wraps the socket transport with the concerns a policy decision needs: request
 * normalization, verdict caching, bounded reconnect backoff, and a health
 * snapshot an operator can read without inspecting the socket directly.
 *
 * The client never decides what an unreachable engine means. It reports the
 * failure and the caller applies the configured failure action, so a transport
 * outage can never silently become an allow.
 * @module dsh-plugin-agentjail/adapter/agentjail-client
 */

import { AgentJailConnection, resolveSocketPath, type ConnectionOptions } from './connection.js'
import {
  HOOK_EVENT,
  normalizeToolCall,
  type NormalizeInput,
  type NormalizedRequest,
} from '../security/normalizer.js'
import { argumentDigest, createRequestId, toWireId } from '../utils/request-id.js'
import type { ControlResult, PolicyDecision, PolicyRequestFrame } from './protocol.js'
import { DaemonUnavailableError, PolicyAbortedError, toAgentJailError } from '../utils/errors.js'
import type { AgentJailError } from '../utils/errors.js'

/** Health of the daemon link, as reported to operators. */
export type HealthState = 'unknown' | 'healthy' | 'degraded' | 'unavailable'

/** A point-in-time health snapshot. */
export interface HealthSnapshot {
  /** Current link state. */
  state: HealthState
  /** Resolved socket path the client targets. */
  socketPath: string
  /** Whether a live socket is pooled. */
  connected: boolean
  /** Consecutive failed requests since the last success. */
  consecutiveFailures: number
  /** Epoch milliseconds of the last successful request, if any. */
  lastSuccessAt?: number
  /** Epoch milliseconds of the last failure, if any. */
  lastFailureAt?: number
  /** Message from the most recent failure, if any. */
  lastError?: string
  /** Daemon-reported version from the most recent successful probe, if any. */
  daemonVersion?: string
}

/** One evaluation outcome, including what happened on the transport. */
export interface EvaluateOutcome {
  /** The normalized request that was sent. */
  request: NormalizedRequest
  /** Digest binding the verdict to the exact arguments. */
  digest: string
  /** The decision, when a trusted one was obtained. */
  decision?: PolicyDecision
  /** The transport or protocol failure, when no decision was obtained. */
  error?: AgentJailError
  /** Whether the value came from the cache rather than the daemon. */
  cached: boolean
  /** Wall-clock duration of the evaluation in milliseconds. */
  durationMs: number
}

/** Cache and health settings for the client. */
export interface ClientOptions extends ConnectionOptions {
  /** Verdict cache settings. */
  cache: {
    enabled: boolean
    maxEntries: number
    ttlMs: number
  }
  /** Working directory reported when a call has none. */
  fallbackCwd: string
}

/** One cached verdict with its expiry. */
interface CacheEntry {
  decision: PolicyDecision
  expiresAt: number
}

/**
 * A bounded, TTL-scoped verdict cache.
 *
 * The key binds the tool name, session, working directory, and argument digest,
 * so a verdict granted for one argument set is never reused for a different
 * one. Entries are evicted in insertion order once the cap is reached.
 */
export class DecisionCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  /**
   * Look up a cached verdict.
   * @param key - the cache key.
   * @param now - current epoch milliseconds.
   * @returns the cached decision, or `undefined` when absent or expired.
   */
  get(key: string, now: number): PolicyDecision | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.decision
  }

  /**
   * Store a verdict, evicting the oldest entry when at capacity.
   * @param key - the cache key.
   * @param decision - the verdict to retain.
   * @param now - current epoch milliseconds.
   */
  set(key: string, decision: PolicyDecision, now: number): void {
    if (this.ttlMs <= 0) return
    this.entries.delete(key)
    this.entries.set(key, { decision, expiresAt: now + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Drop every cached verdict. */
  clear(): void {
    this.entries.clear()
  }

  /** Number of retained entries, including not-yet-swept expired ones. */
  get size(): number {
    return this.entries.size
  }
}

/**
 * Build the cache key for one evaluation.
 * @param request - the normalized request.
 * @param digest - the argument digest.
 * @returns a stable key.
 */
export function cacheKey(request: NormalizedRequest, digest: string): string {
  return [request.toolName, request.sessionId, request.cwd, digest].join('\u0000')
}

/**
 * Client for AgentJail policy evaluation.
 *
 * One instance owns one socket pool and one verdict cache for the lifetime of
 * the plugin, so decisions and health observations are consistent across every
 * tool call in the process.
 */
export class AgentJailClient {
  private readonly connection: AgentJailConnection
  private readonly cache: DecisionCache
  private health: HealthSnapshot
  private probeInFlight: Promise<HealthSnapshot> | undefined

  constructor(private readonly options: ClientOptions) {
    this.connection = new AgentJailConnection(options)
    this.cache = new DecisionCache(options.cache.maxEntries, options.cache.ttlMs)
    this.health = {
      state: 'unknown',
      socketPath: this.connection.socketPath,
      connected: false,
      consecutiveFailures: 0,
    }
  }

  /** The resolved socket path this client targets. */
  get socketPath(): string {
    return this.connection.socketPath
  }

  /**
   * Normalize and evaluate one Harness tool call.
   *
   * A caller cancellation surfaces as {@link PolicyAbortedError}; every other
   * failure surfaces as an `AgentJailError` on `outcome.error` so the caller can
   * apply the configured failure action.
   * @param input - the Harness call to evaluate.
   * @param signal - caller cancellation.
   * @returns the evaluation outcome, including transport failures.
   */
  async evaluateCall(input: NormalizeInput, signal?: AbortSignal): Promise<EvaluateOutcome> {
    const request = normalizeToolCall(input)
    const digest = argumentDigest({
      toolName: input.toolName,
      arguments: input.arguments,
      cwd: request.cwd,
    })
    const startedAt = Date.now()
    const key = cacheKey(request, digest)

    if (this.options.cache.enabled) {
      const cached = this.cache.get(key, startedAt)
      if (cached !== undefined) {
        return { request, digest, decision: cached, cached: true, durationMs: 0 }
      }
    }

    try {
      const decision = await this.evaluate(request, digest, signal)
      if (this.options.cache.enabled) this.cache.set(key, decision, Date.now())
      return {
        request,
        digest,
        decision,
        cached: false,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      const normalized = toAgentJailError(error)
      this.noteFailure(normalized)
      return {
        request,
        digest,
        error: normalized,
        cached: false,
        durationMs: Date.now() - startedAt,
      }
    }
  }

  /** Send one normalized request, updating health on the result. */
  private async evaluate(
    request: NormalizedRequest,
    digest: string,
    signal?: AbortSignal,
  ): Promise<PolicyDecision> {
    const frame = this.toFrame(request, digest)
    try {
      const decision = await this.connection.evaluate(frame, signal)
      this.noteSuccess(undefined)
      return decision
    } catch (error) {
      if (error instanceof PolicyAbortedError) throw error
      throw error
    }
  }

  /** Translate a normalized request into the daemon's wire frame. */
  private toFrame(request: NormalizedRequest, digest: string): PolicyRequestFrame {
    const requestId = createRequestId()
    return {
      id: toWireId(requestId, request.harnessToolName),
      hook_event: request.hookEvent,
      tool_name: request.toolName,
      tool_input: request.toolInput,
      session_id: request.sessionId,
      cwd: request.cwd.length > 0 ? request.cwd : this.options.fallbackCwd,
      agent: request.agentId,
      tool_use_id: digest,
      capabilities: ['dsh-agentjail/1'],
    }
  }

  /**
   * Probe the daemon and refresh the health snapshot.
   * @param signal - caller cancellation.
   * @returns the refreshed snapshot.
   */
  async probe(signal?: AbortSignal): Promise<HealthSnapshot> {
    this.probeInFlight ??= this.runProbe(signal).finally(() => {
      this.probeInFlight = undefined
    })
    return this.probeInFlight
  }

  /** Perform one health probe and fold the result into the snapshot. */
  private async runProbe(signal?: AbortSignal): Promise<HealthSnapshot> {
    try {
      const result = await this.connection.ping(signal)
      if (!result.ok) {
        this.noteFailure(
          new DaemonUnavailableError(result.error ?? 'daemon rejected the health probe'),
        )
        return this.health
      }
      this.noteSuccess(result.version)
      return this.health
    } catch (error) {
      this.noteFailure(toAgentJailError(error))
      return this.health
    }
  }

  /** Record a successful round trip. */
  private noteSuccess(version: string | undefined): void {
    this.health = {
      state: 'healthy',
      socketPath: this.connection.socketPath,
      connected: this.connection.connected,
      consecutiveFailures: 0,
      lastSuccessAt: Date.now(),
      ...(version !== undefined ? { daemonVersion: version } : {}),
      ...(this.health.lastError !== undefined ? { lastError: this.health.lastError } : {}),
    }
  }

  /** Record a failed round trip and derive the degraded/unavailable state. */
  private noteFailure(error: AgentJailError): void {
    const failures = this.connection.failures
    const state: HealthState = failures >= 3 ? 'unavailable' : 'degraded'
    this.health = {
      state,
      socketPath: this.connection.socketPath,
      connected: this.connection.connected,
      consecutiveFailures: failures,
      lastFailureAt: Date.now(),
      lastError: `${error.code}: ${error.message}`,
      ...(this.health.lastSuccessAt !== undefined
        ? { lastSuccessAt: this.health.lastSuccessAt }
        : {}),
      ...(this.health.daemonVersion !== undefined
        ? { daemonVersion: this.health.daemonVersion }
        : {}),
    }
  }

  /**
   * Read the current health snapshot without probing.
   * @returns a copy of the snapshot.
   */
  snapshot(): HealthSnapshot {
    return { ...this.health }
  }

  /** Milliseconds to wait before the next reconnect attempt. */
  backoffMs(): number {
    return this.connection.backoffMs()
  }

  /**
   * Drop every cached verdict, e.g. after a policy reload.
   */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Ask the daemon to reload its policy, then drop cached verdicts.
   *
   * Cache invalidation is folded in because the two must not be separable: a
   * verdict cached under the old policy would otherwise outlive the reload.
   * @param signal - caller cancellation.
   * @returns the control result; `ok` is false when the daemon rejected the reload.
   */
  async reloadPolicy(signal?: AbortSignal): Promise<ControlResult> {
    const result = await this.connection.reload(signal)
    if (result.ok) this.invalidate()
    return result
  }

  /** Number of cached verdicts. */
  get cacheSize(): number {
    return this.cache.size
  }

  /** Close the socket pool. */
  close(): void {
    this.connection.close()
    this.cache.clear()
  }
}

/**
 * Resolve the working directory a call should be evaluated against.
 * @param configured - an explicit working directory from configuration or the session.
 * @param fallback - the process working directory.
 * @returns the directory to report to the policy engine.
 */
export function effectiveCwd(configured: string | undefined, fallback: string): string {
  if (configured !== undefined && configured.length > 0) return configured
  return fallback
}

export { HOOK_EVENT, resolveSocketPath }
export type { ConnectionOptions, NormalizedRequest, PolicyDecision, PolicyRequestFrame }
