/**
 * Sensitive-data redaction.
 *
 * Redaction runs before anything is written to an audit sink, a log line, or a
 * diagnostic payload. It never changes the arguments used for policy evaluation
 * or execution; it only governs what is retained.
 * @module dsh-plugin-agentjail/security/sanitizer
 */

/** Paths whose mere name marks a file as credential-bearing. */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[/\\])\.ssh([/\\]|$)/,
  /(^|[/\\])\.aws([/\\]|$)/,
  /(^|[/\\])\.gnupg([/\\]|$)/,
  /(^|[/\\])\.kube([/\\]|$)/,
  /(^|[/\\])\.docker([/\\]|$)/,
  /(^|[/\\])\.npmrc$/,
  /(^|[/\\])\.pypirc$/,
  /(^|[/\\])\.netrc$/,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|[/\\])\.env(\.|$)/,
  /(^|[/\\])credentials(\.|$)/i,
  /(^|[/\\])secrets?(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
]

/** Argument keys whose values are secret regardless of their content. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|auth|bearer|cookie|session[-_]?id|client[-_]?secret)/i

/** Inline credential shapes redacted from free-form command strings. */
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Credentials assigned or passed inline: `Authorization: Bearer <token>`,
  // `-H "x-api-key: <key>"`, `PASSWORD=<value>`, and the like.
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*["']?[^\s"';]{8,}/gi,
  /\b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY)[A-Z0-9_]*=["']?[^\s"';]{6,}/g,
]

/** Placeholder substituted for every redacted value. */
export const REDACTED = '<redacted>'

/**
 * Report whether a filesystem path names a credential-bearing location.
 *
 * This is a defense-in-depth signal for the normalizer and for report
 * summaries; it never substitutes for the Rego policy's own path rules.
 * @param path - the path to inspect.
 * @returns whether the path matches a known sensitive pattern.
 */
export function isSensitivePath(path: string): boolean {
  if (path.length === 0) return false
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Report whether an argument key conventionally carries a secret value.
 * @param key - the argument key to inspect.
 * @returns whether the key is credential-shaped.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * Replace inline credential material inside a free-form string.
 *
 * Command strings routinely embed tokens that no key-based rule would catch, so
 * they are scrubbed by shape before retention.
 * @param text - the text to scrub.
 * @returns the scrubbed text.
 */
export function redactInlineSecrets(text: string): string {
  let output = text
  for (const pattern of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED)
  }
  return output
}

/**
 * Truncate a string to a maximum length with an explicit marker.
 * @param text - the text to bound.
 * @param maxChars - maximum characters retained; `0` disables truncation.
 * @returns the bounded text.
 */
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…<truncated ${text.length - maxChars} chars>`
}

/**
 * Recursively redact a value for retention.
 *
 * Values under credential-shaped keys, paths that name sensitive locations, and
 * inline secrets inside strings are replaced. The walk is depth- and
 * breadth-bounded so a hostile or oversized argument tree cannot stall the
 * audit path.
 * @param value - the value to redact.
 * @param options - redaction controls.
 * @returns a JSON-safe redacted copy.
 */
export function redactValue(
  value: unknown,
  options: {
    /** Maximum characters retained per leaf string. */
    maxValueChars: number
    /** Maximum traversal depth before deeper values are elided. */
    maxDepth?: number
    /** Maximum array entries and object keys retained per node. */
    maxItems?: number
  },
): unknown {
  const maxDepth = options.maxDepth ?? 8
  const maxItems = options.maxItems ?? 64
  const walk = (node: unknown, depth: number, key: string | undefined): unknown => {
    if (node === null || node === undefined) return node
    if (depth > maxDepth) return '<depth-limit>'
    if (typeof node === 'string') {
      if (key !== undefined && isSensitiveKey(key)) return REDACTED
      if (isSensitivePath(node)) return `<sensitive-path:${REDACTED}>`
      return truncate(redactInlineSecrets(node), options.maxValueChars)
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node
    if (typeof node === 'bigint') return `${node.toString()}n`
    if (typeof node === 'function' || typeof node === 'symbol') return `<${typeof node}>`
    if (Array.isArray(node)) {
      const retained = node.slice(0, maxItems).map((item) => walk(item, depth + 1, key))
      if (node.length > maxItems) retained.push(`<${node.length - maxItems} more items>`)
      return retained
    }
    const entries = Object.entries(node as Record<string, unknown>)
    const output: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of entries.slice(0, maxItems)) {
      output[entryKey] =
        isSensitiveKey(entryKey) && entryValue !== null && entryValue !== undefined
          ? REDACTED
          : walk(entryValue, depth + 1, entryKey)
    }
    if (entries.length > maxItems) output['<truncated>'] = `${entries.length - maxItems} more keys`
    return output
  }
  return walk(value, 0, undefined)
}
