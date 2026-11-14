import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  dashboardPayload,
  renderDashboardText,
  type DashboardData,
} from '../../src/ui/dashboard.js'
import { clampLimit, negotiateFormat, registerDashboardRoutes } from '../../src/ui/routes.js'

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    health: {
      state: 'healthy',
      socketPath: '/tmp/x.sock',
      connected: true,
      consecutiveFailures: 0,
    },
    stats: {
      total: 4,
      byVerdict: { allow: 2, deny: 1, ask: 1 },
      bySource: { engine: 4 },
      byTool: [{ toolName: 'Bash', count: 4 }],
      denyRate: 0.25,
      askRate: 0.25,
      offloadRate: 0,
      meanDurationMs: 3,
      maxDurationMs: 9,
      sessions: 1,
      windowStart: 0,
    },
    records: [
      {
        version: 1,
        seq: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        requestId: 'r1',
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'Bash',
        jailToolName: 'Bash',
        cwd: '/work',
        verdict: 'deny',
        source: 'engine',
        ruleId: 'no-rm-rf',
        reason: 'destructive command',
        arguments: {},
        digest: 'd1',
        durationMs: 3,
      },
    ],
    grants: [
      {
        id: 'g1',
        scope: 'session',
        toolName: 'Write',
        sessionId: 's1',
        digest: 'd1',
        issuedAt: 0,
        expiresAt: 1_800_000_000_000,
      },
    ],
    alerts: [{ kind: 'denied', toolName: 'Bash', sessionId: 's1', message: 'blocked rm -rf' }],
    supervision: 'external',
    enforcement: 'enforce',
    failureAction: 'deny',
    defaultAction: 'deny',
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('dashboard payload', () => {
  it('flattens verdict counts and preserves the denial reason', () => {
    const payload = dashboardPayload(data()) as {
      stats: { allow: number; deny: number }
      records: Array<{ verdict: string; reason?: string }>
    }
    expect(payload.stats.allow).toBe(2)
    expect(payload.stats.deny).toBe(1)
    expect(payload.records[0]?.verdict).toBe('deny')
    expect(payload.records[0]?.reason).toBe('destructive command')
  })

  it('maps a grant scope onto a display field', () => {
    const payload = dashboardPayload(data()) as { grants: Array<{ scope: string }> }
    expect(payload.grants[0]?.scope).toBe('session')
  })

  it('bounds the alert list to the most recent entries', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      kind: 'denied' as const,
      toolName: `tool-${index}`,
      sessionId: 's',
      message: `m${index}`,
    }))
    const payload = dashboardPayload(data({ alerts: many })) as { alerts: unknown[] }
    expect(payload.alerts).toHaveLength(50)
  })

  it('serializes without throwing for an empty state', () => {
    const payload = dashboardPayload(data({ records: [], grants: [], alerts: [] }))
    expect(() => JSON.stringify(payload)).not.toThrow()
  })
})

describe('dashboard text rendering', () => {
  it('renders a fixed-width summary', () => {
    const text = renderDashboardText(data())
    expect(text).toContain('AgentJail security dashboard')
    expect(text).toContain('engine      healthy')
    expect(text).toContain('deny')
    expect(text).toContain('no-rm-rf')
  })

  it('renders the empty state instead of an empty list', () => {
    expect(renderDashboardText(data({ records: [] }))).toContain('(none)')
  })

  it('falls back to a dash when the deny rate is not finite', () => {
    const stats = { ...data().stats, denyRate: Number.NaN }
    expect(renderDashboardText(data({ stats }))).toContain('deny rate   —')
  })

  it('caps the recent-decision list', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...data().records[0]!,
      seq: index,
      ruleId: `rule-${index}`,
    }))
    const text = renderDashboardText(data({ records: many }))
    // The slice keeps the first 50, so entry 49 is the last one rendered.
    expect(text).toContain('rule-49')
    expect(text).not.toContain('rule-50')
  })

  it('renders the alert block when there are alerts', () => {
    expect(renderDashboardText(data())).toContain('alerts:')
    expect(renderDashboardText(data({ alerts: [] }))).not.toContain('alerts:')
  })
})

describe('format negotiation', () => {
  const req = (accept?: string): IncomingMessage =>
    ({ headers: accept === undefined ? {} : { accept } }) as IncomingMessage

  it('prefers an explicit format parameter', () => {
    expect(negotiateFormat(req('text/plain'), 'json')).toBe('json')
    expect(negotiateFormat(req('application/json'), 'text')).toBe('text')
  })

  it('reads the Accept header when no parameter is given', () => {
    expect(negotiateFormat(req('application/json'))).toBe('json')
  })

  it('falls back to text for a wildcard or HTML Accept header', () => {
    expect(negotiateFormat(req('*/*'))).toBe('text')
    expect(negotiateFormat(req('text/html,application/xhtml+xml'))).toBe('text')
    expect(negotiateFormat(req())).toBe('text')
  })
})

describe('limit clamping', () => {
  it('uses the fallback when the parameter is absent or unparsable', () => {
    expect(clampLimit(null, 200)).toBe(200)
    expect(clampLimit('', 200)).toBe(200)
    expect(clampLimit('abc', 200)).toBe(200)
  })

  it('clamps into the range 1..1000', () => {
    expect(clampLimit('0', 200)).toBe(1)
    expect(clampLimit('-5', 200)).toBe(1)
    expect(clampLimit('99999', 200)).toBe(1000)
    expect(clampLimit('25', 200)).toBe(25)
  })
})

/** A minimal web server stand-in that records routes and can dispatch a request. */
function fakeServer() {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>()
  return {
    routes,
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void
    }) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    /**
     * Dispatch a request through the recorded route.
     *
     * The lookup key comes from the request, so the result is narrowed with a
     * `typeof` guard before it is invoked: a `Map.get` miss and a stored value
     * of an unexpected shape both end as a 404 rather than a call.
     */
    dispatch(req: IncomingMessage, res: ServerResponse): void {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const handler: unknown = routes.get(path)
      if (typeof handler !== 'function') {
        res.writeHead(404).end('not found')
        return
      }
      handler(req, res)
    },
  }
}

describe('dashboard routes over HTTP', () => {
  it('serves the text summary and every JSON document from the real server', async () => {
    const server = fakeServer()
    const dispose = registerDashboardRoutes(server, {
      basePath: '/agentjail',
      collect: () => data(),
      recordLimit: 200,
    })
    expect([...server.routes.keys()].sort()).toEqual([
      '/agentjail',
      '/agentjail/api/decisions',
      '/agentjail/api/health',
      '/agentjail/api/summary',
    ])

    const http = createServer((req, res) => server.dispatch(req, res))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    try {
      const text = await fetch(`${base}/agentjail`)
      expect(text.status).toBe(200)
      expect(text.headers.get('content-type')).toContain('text/plain')
      expect(await text.text()).toContain('AgentJail security dashboard')

      const summary = await fetch(`${base}/agentjail/api/summary`)
      const payload = (await summary.json()) as { stats: { total: number } }
      expect(payload.stats.total).toBe(4)

      const health = await fetch(`${base}/agentjail/api/health`)
      const healthBody = (await health.json()) as { state: string; supervision: string }
      expect(healthBody.state).toBe('healthy')
      expect(healthBody.supervision).toBe('external')

      const decisions = await fetch(`${base}/agentjail/api/decisions?verdict=deny&limit=1`)
      const decisionBody = (await decisions.json()) as { count: number }
      expect(decisionBody.count).toBe(1)

      const filtered = await fetch(`${base}/agentjail/api/decisions?verdict=allow`)
      expect(((await filtered.json()) as { count: number }).count).toBe(0)

      // Security headers are set on every response.
      expect(text.headers.get('cache-control')).toBe('no-store')
      expect(text.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
    dispose()
    expect(server.routes.size).toBe(0)
  })

  it('answers 500 with a message when collection throws', async () => {
    const server = fakeServer()
    registerDashboardRoutes(server, {
      basePath: '/agentjail',
      collect: () => {
        throw new Error('audit store is closed')
      },
      recordLimit: 10,
    })
    const http = createServer((req, res) => server.dispatch(req, res))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${port}/agentjail/api/summary`)
      expect(response.status).toBe(500)
      expect(((await response.json()) as { error: string }).error).toContain(
        'audit store is closed',
      )
    } finally {
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
})

describe('dashboard route error and format branches', () => {
  async function serve(
    collect: () => DashboardData,
    run: (base: string) => Promise<void>,
  ): Promise<void> {
    const server = fakeServer()
    registerDashboardRoutes(server, {
      basePath: '/agentjail',
      collect,
      recordLimit: 200,
    })
    const http = createServer((req, res) => server.dispatch(req, res))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as AddressInfo
    try {
      await run(`http://127.0.0.1:${port}`)
    } finally {
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }

  it('serves JSON when the format parameter asks for it', async () => {
    await serve(
      () => data(),
      async (base) => {
        const json = await fetch(`${base}/agentjail?format=json`)
        expect(json.headers.get('content-type')).toContain('application/json')
        expect(((await json.json()) as { stats: { total: number } }).stats.total).toBe(4)

        const text = await fetch(`${base}/agentjail?format=text`)
        expect(text.headers.get('content-type')).toContain('text/plain')
        expect(await text.text()).toContain('AgentJail security dashboard')
      },
    )
  })

  it('answers 500 in plain text when collection throws on the summary route', async () => {
    await serve(
      () => {
        // Deliberately not an Error: the route must still render something
        // useful rather than crash, so this exercises the String(error) path.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'not an error instance'
      },
      async (base) => {
        const response = await fetch(`${base}/agentjail`)
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toContain('text/plain')
        expect(await response.text()).toContain('not an error instance')
      },
    )
  })

  it('answers 500 when the decisions endpoint cannot collect', async () => {
    await serve(
      () => {
        throw new Error('closed')
      },
      async (base) => {
        const response = await fetch(`${base}/agentjail/api/decisions`)
        expect(response.status).toBe(500)
        expect(((await response.json()) as { error: string }).error).toBe('closed')
      },
    )
  })

  it('answers 500 when the health endpoint cannot collect', async () => {
    await serve(
      () => {
        throw new Error('closed')
      },
      async (base) => {
        const response = await fetch(`${base}/agentjail/api/health`)
        expect(response.status).toBe(500)
        expect(((await response.json()) as { error: string }).error).toBe('closed')
      },
    )
  })

  it('survives a disposer that throws, since teardown must not fail the unload', () => {
    const throwing = {
      register() {
        return () => {
          throw new Error('already removed')
        }
      },
    }
    const dispose = registerDashboardRoutes(throwing, {
      basePath: '/agentjail',
      collect: () => data(),
      recordLimit: 10,
    })
    expect(() => dispose()).not.toThrow()
  })
})
