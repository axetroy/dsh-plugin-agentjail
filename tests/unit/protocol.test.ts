import { describe, expect, it } from 'vitest'
import {
  CONTROL_OP_PING,
  CONTROL_TYPE,
  LineDecoder,
  asPolicyAction,
  decodeFrame,
  encodeRequest,
  toControlResult,
  toPolicyDecision,
} from '../../src/adapter/protocol.js'
import { ProtocolError, RequestTooLargeError } from '../../src/utils/errors.js'

describe('encodeRequest', () => {
  it('terminates the frame with a newline', () => {
    const line = encodeRequest({ type: CONTROL_TYPE, op: CONTROL_OP_PING }, 1024)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ type: CONTROL_TYPE, op: CONTROL_OP_PING })
  })

  it('emits the daemon snake_case field names', () => {
    const line = encodeRequest(
      {
        id: 'req-1',
        hook_event: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        session_id: 'sess-1',
        cwd: '/tmp',
      },
      4096,
    )
    expect(JSON.parse(line)).toEqual({
      id: 'req-1',
      hook_event: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'sess-1',
      cwd: '/tmp',
    })
  })

  it('rejects a frame above the size ceiling', () => {
    expect(() =>
      encodeRequest(
        {
          id: 'req-1',
          hook_event: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'x'.repeat(5000) },
          session_id: 's',
          cwd: '/tmp',
        },
        1024,
      ),
    ).toThrow(RequestTooLargeError)
  })
})

describe('decodeFrame', () => {
  it('parses a JSON object line', () => {
    expect(decodeFrame('{"action":"allow"}')).toEqual({ action: 'allow' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(decodeFrame('  {"action":"allow"}  ')).toEqual({ action: 'allow' })
  })

  it('rejects an empty line', () => {
    expect(() => decodeFrame('')).toThrow(ProtocolError)
    expect(() => decodeFrame('   ')).toThrow(ProtocolError)
  })

  it('rejects malformed JSON', () => {
    expect(() => decodeFrame('{not json')).toThrow(ProtocolError)
  })

  it('rejects a JSON array', () => {
    expect(() => decodeFrame('[1,2,3]')).toThrow(ProtocolError)
  })

  it('rejects a bare scalar', () => {
    expect(() => decodeFrame('"allow"')).toThrow(ProtocolError)
    expect(() => decodeFrame('null')).toThrow(ProtocolError)
  })
})

describe('toPolicyDecision', () => {
  it('accepts each known action', () => {
    expect(toPolicyDecision({ action: 'allow' }).action).toBe('allow')
    expect(toPolicyDecision({ action: 'deny' }).action).toBe('deny')
    expect(toPolicyDecision({ action: 'ask' }).action).toBe('ask')
  })

  it('carries rule id, reason, impact, and would_action', () => {
    const decision = toPolicyDecision({
      action: 'deny',
      rule_id: 'no-rm-rf',
      reason: 'destructive delete',
      impact: 'loses data',
      would_action: 'deny',
    })
    expect(decision).toMatchObject({
      action: 'deny',
      ruleId: 'no-rm-rf',
      reason: 'destructive delete',
      impact: 'loses data',
      wouldAction: 'deny',
    })
  })

  it('rejects a missing action rather than defaulting', () => {
    expect(() => toPolicyDecision({})).toThrow(ProtocolError)
    expect(() => toPolicyDecision({ action: null })).toThrow(ProtocolError)
  })

  it('rejects an unrecognized action', () => {
    expect(() => toPolicyDecision({ action: 'maybe' })).toThrow(ProtocolError)
  })

  it('ignores empty optional strings', () => {
    const decision = toPolicyDecision({ action: 'allow', reason: '', rule_id: '' })
    expect(decision.reason).toBeUndefined()
    expect(decision.ruleId).toBeUndefined()
  })

  it('retains the raw frame for audit', () => {
    const frame = { action: 'allow', extra: 'kept' }
    expect(toPolicyDecision(frame).raw).toEqual(frame)
  })
})

describe('asPolicyAction', () => {
  it('narrows known actions and rejects others', () => {
    expect(asPolicyAction('deny')).toBe('deny')
    expect(asPolicyAction('DENY')).toBeUndefined()
    expect(asPolicyAction(1)).toBeUndefined()
    expect(asPolicyAction(undefined)).toBeUndefined()
  })
})

describe('toControlResult', () => {
  it('reads ok, error, and version', () => {
    expect(toControlResult({ ok: true, version: '1.2.3' })).toEqual({ ok: true, version: '1.2.3' })
    expect(toControlResult({ ok: false, error: 'unauthorized' })).toEqual({
      ok: false,
      error: 'unauthorized',
    })
  })

  it('rejects a frame without a boolean ok', () => {
    expect(() => toControlResult({})).toThrow(ProtocolError)
    expect(() => toControlResult({ ok: 'yes' })).toThrow(ProtocolError)
  })
})

describe('LineDecoder', () => {
  it('drains every complete line in a chunk', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('buffers a partial trailing line until it completes', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"a":')).toEqual([])
    expect(decoder.push('1}\n')).toEqual(['{"a":1}'])
  })

  it('reassembles a line split across many chunks', () => {
    const decoder = new LineDecoder()
    const chunks = ['{"act', 'ion":"al', 'low"}\n']
    const lines = chunks.flatMap((chunk) => decoder.push(chunk))
    expect(lines).toEqual(['{"action":"allow"}'])
  })

  it('reports an unterminated remainder', () => {
    const decoder = new LineDecoder()
    decoder.push('partial')
    expect(decoder.remainder()).toBe('partial')
  })

  it('drops the buffer on reset', () => {
    const decoder = new LineDecoder()
    decoder.push('partial')
    decoder.reset()
    expect(decoder.remainder()).toBe('')
  })

  it('ignores a blank line as an empty entry', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('\n')).toEqual([''])
  })
})
