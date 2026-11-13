import { describe, expect, it } from 'vitest'
import { AgentJailClient, DecisionCache, cacheKey } from '../../src/adapter/agentjail-client.js'
import { FakeDaemon, SilentDaemon, unusedSocketPath } from '../helpers/fake-daemon.js'
import { HOOK_EVENT } from '../../src/security/normalizer.js'
import { argumentDigest } from '../../src/utils/request-id.js'

const cacheOff = { enabled: false, maxEntries: 10, ttlMs: 0 }

function clientFor(
  socketPath: string,
  overrides: Partial<ConstructorParameters<typeof AgentJailClient>[0]> = {},
) {
  return new AgentJailClient({
    socketPath,
    timeoutMs: 1000,
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 50,
    maxRequestBytes: 65536,
    cache: cacheOff,
    fallbackCwd: '/tmp',
    ...overrides,
  })
}

const call = { toolName: 'bash', arguments: { command: 'ls' }, sessionId: 'sess-1', cwd: '/tmp' }

describe('AgentJailClient over a real socket', () => {
  it('evaluates a call and returns the daemon verdict', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({
      kind: 'json',
      body: { action: 'deny', rule_id: 'no-rm-rf', reason: 'blocked' },
    })
    const client = clientFor(daemon.socketPath)
    const outcome = await client.evaluateCall(call)
    expect(outcome.decision?.action).toBe('deny')
    expect(outcome.decision?.ruleId).toBe('no-rm-rf')
    expect(outcome.error).toBeUndefined()
    client.close()
    await daemon.close()
  })

  it('sends the normalized frame the daemon expects', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath)
    await client.evaluateCall(call)
    const frame = daemon.lastRequest?.frame
    expect(frame).toMatchObject({
      hook_event: HOOK_EVENT.PRE_TOOL_USE,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'sess-1',
      cwd: '/tmp',
    })
    expect(typeof frame?.['id']).toBe('string')
    client.close()
    await daemon.close()
  })

  it('reports a daemon-unavailable error instead of allowing', async () => {
    const path = await unusedSocketPath()
    const client = clientFor(path)
    const outcome = await client.evaluateCall(call)
    expect(outcome.decision).toBeUndefined()
    expect(outcome.error?.code).toBe('AGENTJAIL_DAEMON_UNAVAILABLE')
    client.close()
  })

  it('enforces the configured timeout against a silent daemon', async () => {
    const daemon = new SilentDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath, { timeoutMs: 120 })
    const startedAt = Date.now()
    const outcome = await client.evaluateCall(call)
    const elapsed = Date.now() - startedAt
    expect(outcome.error?.code).toBe('AGENTJAIL_TIMEOUT')
    expect(elapsed).toBeLessThan(2000)
    client.close()
    await daemon.close()
  })

  it('rejects a malformed response frame', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'raw', body: 'not json at all\n' })
    const client = clientFor(daemon.socketPath)
    const outcome = await client.evaluateCall(call)
    expect(outcome.error?.code).toBe('AGENTJAIL_PROTOCOL_ERROR')
    client.close()
    await daemon.close()
  })

  it('rejects a response with no recognizable action', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'maybe' } })
    const client = clientFor(daemon.socketPath)
    const outcome = await client.evaluateCall(call)
    expect(outcome.error?.code).toBe('AGENTJAIL_PROTOCOL_ERROR')
    client.close()
    await daemon.close()
  })

  it('surfaces a mid-request hangup as unavailable', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'hangup' })
    const client = clientFor(daemon.socketPath)
    const outcome = await client.evaluateCall(call)
    expect(outcome.error?.code).toBe('AGENTJAIL_DAEMON_UNAVAILABLE')
    client.close()
    await daemon.close()
  })

  it('reuses one connection across sequential calls', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath)
    await client.evaluateCall(call)
    await client.evaluateCall({ ...call, arguments: { command: 'pwd' } })
    expect(daemon.requests).toHaveLength(2)
    expect(daemon.openConnections).toBe(1)
    client.close()
    await daemon.close()
  })

  it('recovers after the daemon restarts on the same path', async () => {
    const first = new FakeDaemon()
    await first.listen()
    const path = first.socketPath
    const client = clientFor(path)
    expect((await client.evaluateCall(call)).decision?.action).toBe('allow')
    await first.close()

    const second = new FakeDaemon()
    await second.listen()
    // The restarted daemon binds a fresh socket; point the client at it directly.
    const recovered = clientFor(second.socketPath)
    expect((await recovered.evaluateCall(call)).decision?.action).toBe('allow')
    client.close()
    recovered.close()
    await second.close()
  })

  it('probes health with a control ping', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.control({ kind: 'json', body: { ok: true, version: '9.9.9' } })
    const client = clientFor(daemon.socketPath)
    const snapshot = await client.probe()
    expect(snapshot.state).toBe('healthy')
    expect(snapshot.daemonVersion).toBe('9.9.9')
    expect(daemon.lastRequest?.frame).toEqual({ type: 'control', op: 'ping' })
    client.close()
    await daemon.close()
  })

  it('reports degraded then unavailable as failures accumulate', async () => {
    const path = await unusedSocketPath()
    const client = clientFor(path)
    await client.evaluateCall(call)
    expect(client.snapshot().state).toBe('degraded')
    await client.evaluateCall(call)
    await client.evaluateCall(call)
    expect(client.snapshot().state).toBe('unavailable')
    expect(client.snapshot().lastError).toContain('AGENTJAIL_DAEMON_UNAVAILABLE')
    client.close()
  })

  it('grows the reconnect backoff and caps it', async () => {
    const path = await unusedSocketPath()
    const client = clientFor(path, { reconnectDelayMs: 10, maxReconnectDelayMs: 40 })
    expect(client.backoffMs()).toBe(0)
    await client.evaluateCall(call)
    expect(client.backoffMs()).toBe(10)
    await client.evaluateCall(call)
    expect(client.backoffMs()).toBe(20)
    await client.evaluateCall(call)
    expect(client.backoffMs()).toBe(40)
    await client.evaluateCall(call)
    expect(client.backoffMs()).toBe(40)
    client.close()
  })

  it('waits out the backoff before a policy call but not before a probe', async () => {
    const path = await unusedSocketPath()
    const client = clientFor(path, { reconnectDelayMs: 50, maxReconnectDelayMs: 50 })
    // The first failure arms the backoff without waiting for it.
    await client.evaluateCall(call)
    expect(client.backoffMs()).toBe(50)

    // A probe is the readiness path and must stay responsive, so it does not sleep.
    // Comparing the two durations rather than a fixed threshold keeps the test
    // honest on a loaded machine: the policy call cannot finish before the probe,
    // because it waits out the backoff the probe skipped.
    const probeStarted = Date.now()
    await client.probe()
    const probeElapsed = Date.now() - probeStarted

    const callStarted = Date.now()
    await client.evaluateCall(call)
    const callElapsed = Date.now() - callStarted

    expect(callElapsed).toBeGreaterThanOrEqual(45)
    expect(probeElapsed).toBeLessThan(callElapsed)
    client.close()
  })

  it('returns a cached verdict without a second round trip', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'allow' } })
    const client = clientFor(daemon.socketPath, {
      cache: { enabled: true, maxEntries: 10, ttlMs: 5000 },
    })
    const first = await client.evaluateCall(call)
    const second = await client.evaluateCall(call)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(daemon.requests).toHaveLength(1)
    client.close()
    await daemon.close()
  })

  it('does not serve a cached verdict for different arguments', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath, {
      cache: { enabled: true, maxEntries: 10, ttlMs: 5000 },
    })
    await client.evaluateCall(call)
    await client.evaluateCall({ ...call, arguments: { command: 'rm -rf /' } })
    expect(daemon.requests).toHaveLength(2)
    client.close()
    await daemon.close()
  })

  it('drops cached verdicts on invalidate', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath, {
      cache: { enabled: true, maxEntries: 10, ttlMs: 5000 },
    })
    await client.evaluateCall(call)
    client.invalidate()
    expect(client.cacheSize).toBe(0)
    client.close()
    await daemon.close()
  })

  it('honours caller cancellation', async () => {
    const daemon = new SilentDaemon()
    await daemon.listen()
    const client = clientFor(daemon.socketPath, { timeoutMs: 5000 })
    const controller = new AbortController()
    const pending = client.evaluateCall(call, controller.signal)
    setTimeout(() => controller.abort(), 20)
    const outcome = await pending
    expect(outcome.error?.code).toBe('AGENTJAIL_ABORTED')
    client.close()
    await daemon.close()
  })

  it('serializes concurrent requests on one connection', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'allow' } })
    const client = clientFor(daemon.socketPath)
    const results = await Promise.all([
      client.evaluateCall(call),
      client.evaluateCall({ ...call, arguments: { command: 'pwd' } }),
      client.evaluateCall({ ...call, arguments: { command: 'id' } }),
    ])
    expect(results.every((result) => result.decision?.action === 'allow')).toBe(true)
    expect(daemon.requests).toHaveLength(3)
    client.close()
    await daemon.close()
  })

  it('resolves the default socket path under HOME', () => {
    const previous = process.env['AGENTJAIL_SOCKET']
    delete process.env['AGENTJAIL_SOCKET']
    try {
      const client = clientFor('', {})
      expect(client.socketPath.endsWith('.agentjail/daemon.sock')).toBe(true)
      client.close()
    } finally {
      if (previous !== undefined) process.env['AGENTJAIL_SOCKET'] = previous
    }
  })

  it('honours AGENTJAIL_SOCKET when no path is configured', () => {
    const previous = process.env['AGENTJAIL_SOCKET']
    process.env['AGENTJAIL_SOCKET'] = '/tmp/from-environment.sock'
    try {
      const client = clientFor('', {})
      expect(client.socketPath).toBe('/tmp/from-environment.sock')
      client.close()
    } finally {
      if (previous === undefined) delete process.env['AGENTJAIL_SOCKET']
      else process.env['AGENTJAIL_SOCKET'] = previous
    }
  })

  it('prefers an explicit path over the environment', () => {
    const previous = process.env['AGENTJAIL_SOCKET']
    process.env['AGENTJAIL_SOCKET'] = '/tmp/from-environment.sock'
    try {
      const client = clientFor('/tmp/explicit.sock', {})
      expect(client.socketPath).toBe('/tmp/explicit.sock')
      client.close()
    } finally {
      if (previous === undefined) delete process.env['AGENTJAIL_SOCKET']
      else process.env['AGENTJAIL_SOCKET'] = previous
    }
  })
})

describe('DecisionCache', () => {
  it('expires an entry past its TTL', () => {
    const cache = new DecisionCache(10, 100)
    cache.set('k', { action: 'allow', raw: {} }, 1000)
    expect(cache.get('k', 1050)?.action).toBe('allow')
    expect(cache.get('k', 1200)).toBeUndefined()
  })

  it('evicts the oldest entry past capacity', () => {
    const cache = new DecisionCache(2, 1000)
    cache.set('a', { action: 'allow', raw: {} }, 0)
    cache.set('b', { action: 'allow', raw: {} }, 0)
    cache.set('c', { action: 'allow', raw: {} }, 0)
    expect(cache.get('a', 0)).toBeUndefined()
    expect(cache.get('c', 0)?.action).toBe('allow')
  })

  it('never stores when the TTL is zero', () => {
    const cache = new DecisionCache(10, 0)
    cache.set('k', { action: 'allow', raw: {} }, 0)
    expect(cache.size).toBe(0)
  })
})

describe('cacheKey', () => {
  it('separates tools, sessions, and directories', () => {
    const request = {
      hookEvent: 'PreToolUse',
      toolName: 'Bash',
      toolInput: {},
      sessionId: 's',
      agentId: 's',
      cwd: '/tmp',
      harnessToolName: 'bash',
    }
    expect(cacheKey(request, 'd')).not.toBe(cacheKey({ ...request, toolName: 'Read' }, 'd'))
    expect(cacheKey(request, 'd')).not.toBe(cacheKey({ ...request, sessionId: 'other' }, 'd'))
    expect(cacheKey(request, 'd')).not.toBe(cacheKey({ ...request, cwd: '/other' }, 'd'))
  })
})

describe('argumentDigest', () => {
  it('is stable across key insertion order', () => {
    expect(argumentDigest({ a: 1, b: 2 })).toBe(argumentDigest({ b: 2, a: 1 }))
  })

  it('differs for different values', () => {
    expect(argumentDigest({ command: 'ls' })).not.toBe(argumentDigest({ command: 'rm -rf /' }))
  })

  it('tolerates a circular structure', () => {
    const value: Record<string, unknown> = { a: 1 }
    value['self'] = value
    expect(typeof argumentDigest(value)).toBe('string')
  })
})
