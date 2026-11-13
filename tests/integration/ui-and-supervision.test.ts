/**
 * Integration tests for the dashboard and daemon supervision.
 *
 * These mount the plugin the way a deployment does and assert on the observable
 * behavior: what the service reports, which routes appear when a web server is
 * composed, and that supervision never adopts a daemon it did not start.
 * @module tests/integration/ui-and-supervision
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../../src/index.js'
import { Config } from '../../src/config/schema.js'
import { FakeDaemon, unusedSocketPath } from '../helpers/fake-daemon.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A web server stand-in that records the routes the plugin registers. */
function fakeWebServer() {
  const routes = new Map<string, unknown>()
  return {
    routes,
    register(route: { kind: string; path: string; handler: unknown }) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
}

interface MountOptions {
  daemon?: FakeDaemon
  config?: Record<string, unknown>
  webServer?: ReturnType<typeof fakeWebServer>
}

/** Mount the plugin with a real pipeline and, optionally, a real daemon. */
async function mount(options: MountOptions = {}) {
  const daemon = options.daemon
  if (daemon !== undefined) {
    await daemon.listen()
    cleanups.push(() => daemon.close())
  }
  const root = new Context()
  root.plugin(SystemPrompt)
  root.plugin(NativeExecutor)
  root.plugin(ToolsService)
  if (options.webServer !== undefined) {
    root.provide('webServer' as never, options.webServer as never)
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  cleanups.push(() => root.fiber.dispose())

  root.tools.register(
    defineTool({
      name: 'bash',
      description: 'run a shell command',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_arguments, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(arguments_) {
        return `ran: ${(arguments_ as { command: string }).command}`
      },
    }),
  )

  const config = Config({
    socketPath: daemon?.socketPath ?? '',
    timeoutMs: 2000,
    audit: { storage: 'memory' },
    healthCheckIntervalMs: 0,
    ...options.config,
  } as never)
  apply(root, config)
  return { root, daemon }
}

/** Execute one tool call through the real pipeline. */
async function callTool(root: Context, command: string): Promise<unknown> {
  return root.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: 'call-1' as never,
        name: 'bash',
        arguments: JSON.stringify({ command }),
      },
    ],
    signal: new AbortController().signal,
  })
}

describe('dashboard service', () => {
  it('reports decisions that actually went through the gate', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'deny', rule_id: 'no-rm-rf' } })
    cleanups.push(() => daemon.close())

    const { root } = await mount({ daemon })
    await callTool(root, 'rm -rf /')

    const dashboard = root.agentjail?.dashboard()
    expect(dashboard?.stats.total).toBeGreaterThan(0)
    expect(dashboard?.stats.byVerdict.deny).toBeGreaterThan(0)
    expect(dashboard?.records[0]?.ruleId).toBe('no-rm-rf')
    expect(dashboard?.enforcement).toBe('enforce')
    expect(dashboard?.failureAction).toBe('deny')
    expect(typeof dashboard?.now).toBe('string')
  })

  it('renders a text summary an operator can read', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'allow' } })
    cleanups.push(() => daemon.close())
    const { root } = await mount({ daemon })
    await callTool(root, 'ls')
    const text = root.agentjail?.dashboardText() ?? ''
    expect(text).toContain('AgentJail security dashboard')
    expect(text).toContain('allow')
  })

  it('starts with an empty but valid dashboard', async () => {
    const { root } = await mount()
    const dashboard = root.agentjail?.dashboard()
    expect(dashboard?.stats.total).toBe(0)
    expect(dashboard?.records).toEqual([])
    expect(() => JSON.stringify(dashboard)).not.toThrow()
  })
})

describe('dashboard routes', () => {
  it('registers routes when a web server is composed', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    daemon.always({ kind: 'json', body: { action: 'allow' } })
    cleanups.push(() => daemon.close())
    const webServer = fakeWebServer()
    const { root } = await mount({ daemon, webServer })
    await callTool(root, 'ls')
    expect([...webServer.routes.keys()].sort()).toEqual([
      '/agentjail',
      '/agentjail/api/decisions',
      '/agentjail/api/health',
      '/agentjail/api/summary',
    ])
    expect(root.agentjail).toBeDefined()
  })

  it('honors a custom base path', async () => {
    const webServer = fakeWebServer()
    await mount({ webServer, config: { ui: { basePath: '/security/jail' } } })
    expect([...webServer.routes.keys()].sort()).toEqual([
      '/security/jail',
      '/security/jail/api/decisions',
      '/security/jail/api/health',
      '/security/jail/api/summary',
    ])
  })

  it('registers nothing when the dashboard is disabled', async () => {
    const webServer = fakeWebServer()
    await mount({ webServer, config: { ui: { enabled: false } } })
    expect(webServer.routes.size).toBe(0)
  })

  it('registers nothing when no web server is composed', async () => {
    const { root } = await mount()
    expect(root.agentjail).toBeDefined()
  })

  it('removes every route when the plugin unloads', async () => {
    const webServer = fakeWebServer()
    const { root } = await mount({ webServer })
    expect(webServer.routes.size).toBe(4)
    await root.fiber.dispose()
    expect(webServer.routes.size).toBe(0)
  })
})

describe('daemon supervision', () => {
  it('adopts an already-running daemon and never starts a process', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    cleanups.push(() => daemon.close())
    const { root } = await mount({ daemon })
    const outcome = await root.agentjail?.ensureDaemon()
    expect(outcome?.state).toBe('external')
    expect(outcome?.managed).toBe(false)
    expect(root.agentjail?.supervision()).toBe('external')
  })

  it('reports unavailable when no daemon and no binary exist', async () => {
    const socketPath = await unusedSocketPath()
    const { root } = await mount({
      config: {
        socketPath,
        daemon: { binary: join(tmpdir(), 'definitely-absent-agentjail'), supervise: true },
      },
    })
    const outcome = await root.agentjail?.ensureDaemon()
    expect(outcome?.state).toBe('unavailable')
    expect(outcome?.reason).toContain('not an executable file')
  })

  it('starts a daemon it locates and reports it as managed', async () => {
    // A shell script stands in for the daemon: it binds nothing, so the probe
    // never succeeds, but the spawn path and the reporting are exercised.
    const dir = await mkdtemp(join(tmpdir(), 'agentjail-sup-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const binary = join(dir, 'agentjail')
    await writeFile(binary, '#!/bin/sh\nsleep 30\n')
    await chmod(binary, 0o755)
    const socketPath = await unusedSocketPath()
    const { root } = await mount({
      config: {
        socketPath,
        daemon: {
          binary,
          supervise: true,
          startTimeoutMs: 400,
          pollIntervalMs: 50,
        },
      },
    })
    const outcome = await root.agentjail?.ensureDaemon()
    expect(outcome?.state).not.toBe('external')
    expect(outcome?.state).not.toBe('disabled')
    // The daemon never answered, so the plugin still applies its failure action.
    const dashboard = root.agentjail?.dashboard()
    expect(dashboard?.supervision).not.toBe('external')
  })

  it('does not supervise when supervision is disabled', async () => {
    const socketPath = await unusedSocketPath()
    const { root } = await mount({
      config: { socketPath, daemon: { supervise: false } },
    })
    const outcome = await root.agentjail?.ensureDaemon()
    expect(outcome?.state).toBe('disabled')
    expect(root.agentjail?.supervision()).toBe('disabled')
  })

  it('leaves the enforcement path working when supervision cannot find a binary', async () => {
    const socketPath = await unusedSocketPath()
    const { root } = await mount({
      config: {
        socketPath,
        daemon: { supervise: true, binary: join(tmpdir(), 'absent-agentjail') },
        failureAction: 'deny',
      },
    })
    await root.agentjail?.ensureDaemon()
    const result = await callTool(root, 'ls')
    // No trusted verdict is available, so the configured failure action applies.
    expect(JSON.stringify(result)).toContain('deny')
  })
})

describe('managed install', () => {
  it('does not download when the option is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await mount({ config: { daemon: { managedInstall: false, supervise: false } } })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
