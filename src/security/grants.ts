/**
 * Approval grant store.
 *
 * A one-time grant authorizes exactly one subsequent evaluation of the same call
 * identity and is consumed on use. A session grant authorizes repeat calls of the
 * same identity inside one session until it expires or is revoked. Grants are
 * keyed by the argument digest, so approving `rm -rf build/` never authorizes
 * `rm -rf /`.
 * @module dsh-plugin-agentjail/security/grants
 */

import { fnv1a } from '../utils/request-id.js'

/** Grant lifetime class. */
export type GrantScope = 'once' | 'session'

/** One issued grant. */
export interface Grant {
  /** Stable identifier for revocation. */
  id: string
  /** Lifetime class. */
  scope: GrantScope
  /** Tool name the grant was issued for. */
  toolName: string
  /** Session the grant is bound to. */
  sessionId: string
  /** Digest of the exact arguments the grant authorizes. */
  digest: string
  /** Epoch milliseconds when the grant was issued. */
  issuedAt: number
  /** Epoch milliseconds after which the grant is void; `Infinity` for one-time grants. */
  expiresAt: number
  /** Human-readable reason carried from the approval. */
  reason?: string
}

/** Outcome of consuming a grant. */
export type GrantConsumption = { kind: 'granted'; grant: Grant } | { kind: 'missing' }

/** Grant store settings. */
export interface GrantStoreOptions {
  /** Maximum retained grants; the oldest is evicted past this size. */
  maxGrants: number
  /** Session grant lifetime in milliseconds. */
  sessionGrantTtlMs: number
}

/**
 * Bounded in-memory store of issued approvals.
 *
 * One-time grants are removed the moment they are consumed, so a single
 * approval cannot authorize a second call. Session grants expire on a TTL and
 * are evicted oldest-first when the store is at capacity.
 */
export class GrantStore {
  private readonly grants = new Map<string, Grant>()

  constructor(private readonly options: GrantStoreOptions) {}

  /** Build the store key binding a session, tool, and argument digest. */
  private static key(sessionId: string, toolName: string, digest: string): string {
    return `${sessionId}\u0000${toolName}\u0000${digest}`
  }

  /**
   * Issue a grant for one call identity.
   * @param input - the grant identity and lifetime class.
   * @returns the issued grant.
   */
  issue(input: {
    scope: GrantScope
    toolName: string
    sessionId: string
    digest: string
    reason?: string
    now?: number
  }): Grant {
    const now = input.now ?? Date.now()
    const grant: Grant = {
      id: fnv1a(`${input.sessionId}|${input.toolName}|${input.digest}|${now}`),
      scope: input.scope,
      toolName: input.toolName,
      sessionId: input.sessionId,
      digest: input.digest,
      issuedAt: now,
      expiresAt:
        input.scope === 'session' ? now + this.options.sessionGrantTtlMs : Number.POSITIVE_INFINITY,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }
    const key = GrantStore.key(input.sessionId, input.toolName, input.digest)
    this.grants.delete(key)
    this.grants.set(key, grant)
    this.evict(now)
    return grant
  }

  /**
   * Consume a grant for one call identity.
   *
   * A one-time grant is deleted as part of consumption, so the check and the
   * removal cannot be separated by another caller.
   * @param input - the call identity to check.
   * @returns the consumed grant, or a miss.
   */
  consume(input: {
    toolName: string
    sessionId: string
    digest: string
    now?: number
  }): GrantConsumption {
    const now = input.now ?? Date.now()
    const key = GrantStore.key(input.sessionId, input.toolName, input.digest)
    const grant = this.grants.get(key)
    if (grant === undefined) return { kind: 'missing' }
    if (grant.expiresAt <= now) {
      this.grants.delete(key)
      return { kind: 'missing' }
    }
    if (grant.scope === 'once') this.grants.delete(key)
    return { kind: 'granted', grant }
  }

  /**
   * Report whether a grant exists for one call identity, without consuming it.
   * @param input - the call identity to check.
   * @returns whether a live grant exists.
   */
  has(input: { toolName: string; sessionId: string; digest: string; now?: number }): boolean {
    const now = input.now ?? Date.now()
    const grant = this.grants.get(GrantStore.key(input.sessionId, input.toolName, input.digest))
    if (grant === undefined) return false
    if (grant.expiresAt <= now) {
      this.grants.delete(GrantStore.key(input.sessionId, input.toolName, input.digest))
      return false
    }
    return true
  }

  /**
   * Revoke a grant by id.
   * @param id - the grant identifier.
   * @returns whether a grant was removed.
   */
  revoke(id: string): boolean {
    for (const [key, grant] of this.grants) {
      if (grant.id === id) {
        this.grants.delete(key)
        return true
      }
    }
    return false
  }

  /**
   * Revoke every grant bound to a session.
   * @param sessionId - the session whose grants are dropped.
   * @returns the number of grants removed.
   */
  revokeSession(sessionId: string): number {
    let removed = 0
    for (const [key, grant] of this.grants) {
      if (grant.sessionId === sessionId) {
        this.grants.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** Drop expired grants and enforce the capacity bound. */
  private evict(now: number): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key)
    }
    while (this.grants.size > this.options.maxGrants) {
      const oldest = this.grants.keys().next()
      if (oldest.done === true) break
      this.grants.delete(oldest.value)
    }
  }

  /** Snapshot every live grant, for reporting. */
  list(now = Date.now()): Grant[] {
    this.evict(now)
    return [...this.grants.values()].map((grant) => ({ ...grant }))
  }

  /** Number of retained grants. */
  get size(): number {
    return this.grants.size
  }

  /** Drop every grant. */
  clear(): void {
    this.grants.clear()
  }
}
