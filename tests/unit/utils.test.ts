import { describe, expect, it } from 'vitest'
import { fnv1a, stableStringify } from '../../src/utils/request-id.js'
import {
  AgentJailError,
  ErrorCode,
  PolicyAbortedError,
  DaemonUnavailableError,
  toAgentJailError,
} from '../../src/utils/errors.js'

describe('stableStringify', () => {
  it('sorts object keys so equal values serialize identically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(stableStringify({ a: 2, b: 1 })).toBe(stableStringify({ b: 1, a: 2 }))
  })

  it('serializes primitives and null at the top level', () => {
    // `JSON.stringify(undefined)` is `undefined`, so the encoder must fall back
    // to the literal `null` rather than producing the string "undefined".
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify(7)).toBe('7')
    expect(stableStringify('x')).toBe('"x"')
  })

  it('marks a circular reference instead of recursing forever', () => {
    const node: Record<string, unknown> = { a: 1 }
    node['self'] = node
    expect(stableStringify(node)).toContain('"<circular>"')
  })

  it('serializes arrays in order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })
})

describe('fnv1a', () => {
  it('is stable and 16 hex characters wide', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(fnv1a('abc')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('separates different inputs', () => {
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
  })
})

describe('toAgentJailError', () => {
  it('returns an AgentJailError unchanged', () => {
    const original = new DaemonUnavailableError('down')
    expect(toAgentJailError(original)).toBe(original)
  })

  it('maps an AbortError onto the aborted code, so a cancel is not a deny', () => {
    const abort = new Error('aborted by caller')
    abort.name = 'AbortError'
    const mapped = toAgentJailError(abort)
    expect(mapped).toBeInstanceOf(PolicyAbortedError)
    expect(mapped.code).toBe(ErrorCode.ABORTED)
    expect(mapped.message).toBe('aborted by caller')
  })

  it('maps an ordinary Error onto a transport failure', () => {
    const mapped = toAgentJailError(new Error('socket hang up'))
    expect(mapped).toBeInstanceOf(DaemonUnavailableError)
    expect(mapped.code).toBe(ErrorCode.DAEMON_UNAVAILABLE)
    expect(mapped.cause).toBeInstanceOf(Error)
  })

  it('maps a thrown non-Error without losing the value', () => {
    const mapped = toAgentJailError('just a string')
    expect(mapped).toBeInstanceOf(AgentJailError)
    expect(mapped.message).toBe('just a string')
    expect(mapped.cause).toBe('just a string')
  })
})
