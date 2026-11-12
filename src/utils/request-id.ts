/**
 * Request identity helpers.
 *
 * Each policy evaluation carries a correlation id that is stable within one
 * tool call and unique across calls, so a daemon response can be matched to its
 * request even when several evaluations share a socket.
 * @module dsh-plugin-agentjail/utils/request-id
 */

import { randomUUID } from 'node:crypto'

/** Create a fresh, globally unique request id for one policy evaluation. */
export function createRequestId(): string {
  return randomUUID()
}

/**
 * Build the AgentJail `id` field from a request id and tool name.
 *
 * The daemon echoes this value on its response, so it doubles as the correlation
 * key for one `Request`/`Response` pair.
 * @param requestId - the plugin-generated request id.
 * @param toolName - the tool the evaluation is about.
 * @returns the wire `id` value.
 */
export function toWireId(requestId: string, toolName: string): string {
  return `dsh-agentjail-${requestId}-${toolName}`
}

/**
 * Derive a stable identity key for one call's arguments.
 *
 * Used to bind approvals and cache entries to the exact arguments, so a
 * modified argument set cannot reuse a previous grant or cached verdict.
 * @param value - the value to digest.
 * @returns a stable string digest.
 */
export function argumentDigest(value: unknown): string {
  const canonical = stableStringify(value)
  return fnv1a(canonical)
}

/**
 * Serialize a JSON-compatible value with sorted object keys.
 *
 * The result is deterministic for equal values regardless of key insertion
 * order, which the approval binding and cache keys depend on.
 * @param value - the value to serialize.
 * @returns a canonical JSON string.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const encode = (node: unknown): string => {
    if (node === null || typeof node !== 'object') return JSON.stringify(node) ?? 'null'
    if (seen.has(node)) return '"<circular>"'
    seen.add(node)
    if (Array.isArray(node)) return `[${node.map((item) => encode(item)).join(',')}]`
    const entries = Object.entries(node as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`
  }
  return encode(value)
}

/**
 * Compute a fast, non-cryptographic 64-bit FNV-1a digest as hex.
 *
 * This is a cache and approval-binding key, not a security boundary: the digest
 * is only compared against another digest computed the same way, in-process.
 * @param input - the string to digest.
 * @returns a 16-character hexadecimal digest.
 */
export function fnv1a(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
