/**
 * Integration tests against a real Cordis runtime and a real AgentJail socket.
 *
 * These mount the plugin the way a deployment does — `root.plugin(...)` with the
 * real `ToolsService`, `SystemPrompt`, and `NativeToolExecutor` — register real
 * tools through `defineTool`, and then execute real tool calls. The assertion
 * that matters most is that a denied call's body never runs: that is the whole
 * point of the plugin, and only a real pipeline can prove it.
 * @module tests/integration/plugin
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../../src/index.js'
import { Config } from '../../src/config/schema.js'
import { FakeDaemon, SilentDaemon } from '../helpers/fake-daemon.js'

/** Resources to release after each test. */
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Harness {
  root: Context
  daemon: FakeDaemon
  executed: string[]
}

/**
 * Mount the real Harness pipeline with the plugin installed.
 * @param configOverrides - plugin configuration overrides.
 * @param daemonReply - the verdict the fake daemon returns.
 * @returns the harness, with a record of tool bodies that actually ran.
 */
async function harness(
  configOverrides: Record<string, unknown> = {},
  daemonReply: Record<string, unknown> = { action: 'allow' },
  providedDaemon?: FakeDaemon,
): Promise<Harness> {
  const daemon = providedDaemon ?? new FakeDaemon()
  if (providedDaemon === undefined) await daemon.listen()
  if (daemonReply['action'] !== undefined) daemon.always({ kind: 'json', body: daemonReply })
  cleanups.push(() => daemon.close())

  const root = new Context()
  root.plugin(SystemPrompt)
  root.plugin(NativeExecutor)
  root.plugin(ToolsService)
  await new Promise((resolve) => setTimeout(resolve, 50))
  cleanups.push(() => root.fiber.dispose())

  const executed: string[] = []
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
        executed.push(String((arguments_ as { command: string }).command))
        return `ran: ${(arguments_ as { command: string }).command}`
      },
    }),
  )
  root.tools.register(
    defineTool({
      name: 'read',
      description: 'read a file',
      parameters: { file_path: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_arguments, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(arguments_) {
        executed.push(`read:${(arguments_ as { file_path: string }).file_path}`)
        return 'contents'
      },
    }),
  )

  const config = Config({
    socketPath: daemon.socketPath,
    timeoutMs: 2000,
    audit: { storage: 'memory' },
    ...configOverrides,
  } as never)
  apply(root, config)
  return { root, daemon, executed }
}

/** Execute one tool call through the real pipeline. */
async function callTool(
  root: Context,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Awaited<ReturnType<Context['tools']['execute']>>> {
  const controller = new AbortController()
  return root.tools.execute({
    calls: [
      { type: 'tool-call', id: 'call-1' as never, name, arguments: JSON.stringify(arguments_) },
    ],
    signal: controller.signal,
  })
}

/** Extract the model-facing text from a batch result. */
function resultText(result: Awaited<ReturnType<Context['tools']['execute']>>): string {
  return JSON.stringify(result)
}

describe('plugin mounted on the real Harness pipeline', () => {
  it('allows a permitted call and runs its body', async () => {
    const { root, executed } = await harness({}, { action: 'allow' })
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual(['ls'])
    expect(resultText(result)).toContain('ran: ls')
  })

  it('denies a call without ever running its body', async () => {
    const { root, executed } = await harness(
      {},
      { action: 'deny', rule_id: 'no-rm-rf', reason: 'recursive force delete' },
    )
    const result = await callTool(root, 'bash', { command: 'rm -rf /' })
    expect(executed).toEqual([])
    const text = resultText(result)
    expect(text).toContain('no-rm-rf')
    expect(text).toContain('recursive force delete')
  })

  it('carries the denial reason back to the model', async () => {
    const { root } = await harness({}, { action: 'deny', reason: 'blocked by policy' })
    const text = resultText(await callTool(root, 'bash', { command: 'ls' }))
    expect(text).toContain('blocked by policy')
    expect(text).toContain('AgentJail')
  })

  it('sends the normalized AgentJail tool name for bash', async () => {
    const { root, daemon } = await harness()
    await callTool(root, 'bash', { command: 'ls -la' })
    expect(daemon.lastRequest?.frame['tool_name']).toBe('Bash')
    expect(daemon.lastRequest?.frame['tool_input']).toEqual({ command: 'ls -la' })
  })

  it('sends the normalized AgentJail tool name for read', async () => {
    const { root, daemon } = await harness()
    await callTool(root, 'read', { file_path: '/tmp/a.txt' })
    expect(daemon.lastRequest?.frame['tool_name']).toBe('Read')
    expect(daemon.lastRequest?.frame['tool_input']).toEqual({ file_path: '/tmp/a.txt' })
  })

  it('fails closed when the daemon is unreachable', async () => {
    const daemon = new FakeDaemon()
    await daemon.listen()
    const path = daemon.socketPath
    await daemon.close()

    const root = new Context()
    root.plugin(SystemPrompt)
    root.plugin(NativeExecutor)
    root.plugin(ToolsService)
    await new Promise((resolve) => setTimeout(resolve, 50))
    cleanups.push(() => root.fiber.dispose())

    const executed: string[] = []
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
          executed.push(String((arguments_ as { command: string }).command))
          return 'ran'
        },
      }),
    )
    apply(root, Config({ socketPath: path, timeoutMs: 300, audit: { storage: 'memory' } } as never))

    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual([])
    expect(resultText(result)).toContain('AGENTJAIL_DAEMON_UNAVAILABLE')
  })

  it('fails closed on a timeout', async () => {
    const silent = new SilentDaemon()
    await silent.listen()
    const { root, executed } = await harness({ timeoutMs: 150 }, {}, silent)
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual([])
    expect(resultText(result)).toContain('AGENTJAIL_TIMEOUT')
  })

  it('bypasses the engine for an exempt tool', async () => {
    const { root, daemon, executed } = await harness({ exemptTools: ['read'] }, { action: 'deny' })
    const result = await callTool(root, 'read', { file_path: '/tmp/a.txt' })
    expect(executed).toEqual(['read:/tmp/a.txt'])
    expect(daemon.policyRequests).toHaveLength(0)
    expect(resultText(result)).toContain('contents')
  })

  it('applies a configured tool override', async () => {
    const { root, executed } = await harness(
      { overrides: { tools: { bash: { action: 'deny', reason: 'shell is disabled' } } } },
      { action: 'allow' },
    )
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual([])
    expect(resultText(result)).toContain('shell is disabled')
  })

  it('records one audit record per decision', async () => {
    const { root } = await harness({}, { action: 'deny', rule_id: 'r1' })
    await callTool(root, 'bash', { command: 'ls' })
    const service = root.agentjail
    expect(service).toBeDefined()
    const records = service?.queryAudit()
    expect(records).toHaveLength(1)
    expect(records?.[0]?.verdict).toBe('deny')
    expect(records?.[0]?.ruleId).toBe('r1')
    expect(records?.[0]?.toolName).toBe('bash')
  })

  it('redacts secrets in the audit record', async () => {
    const { root } = await harness()
    await callTool(root, 'bash', {
      command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrst"',
    })
    const record = root.agentjail?.queryAudit()[0]
    const arguments_ = record?.arguments as Record<string, unknown> | undefined
    expect(typeof arguments_?.['command']).toBe('string')
    const command = arguments_?.['command'] as string
    expect(command).not.toContain('abcdefghijklmnopqrst')
    expect(command).toContain('<redacted>')
  })

  it('feeds the risk metrics window', async () => {
    const { root } = await harness({}, { action: 'deny' })
    await callTool(root, 'bash', { command: 'ls' })
    const stats = root.agentjail?.stats()
    expect(stats?.total).toBe(1)
    expect(stats?.byVerdict.deny).toBe(1)
  })

  it('reports engine health through the service', async () => {
    const { root } = await harness()
    const health = await root.agentjail?.probeHealth()
    expect(health?.state).toBe('healthy')
  })

  it('renders a security report', async () => {
    const { root } = await harness()
    await callTool(root, 'bash', { command: 'ls' })
    const text = root.agentjail?.reportText() ?? ''
    expect(text).toContain('DeepSeek Harness AgentJail security report')
    expect(text).toContain('Enforcement')
  })

  it('blocks an ask when no approval service is composed', async () => {
    const { root, executed } = await harness({}, { action: 'ask', reason: 'needs approval' })
    const result = await callTool(root, 'bash', { command: 'ls' })
    // The registry fails closed on an unanswerable ask, so the body never runs.
    expect(executed).toEqual([])
    expect(resultText(result)).toContain('needs approval')
  })

  it('does not block in monitor mode but records the verdict', async () => {
    const { root, executed } = await harness(
      { enforcement: 'monitor' },
      { action: 'deny', rule_id: 'r1' },
    )
    await callTool(root, 'bash', { command: 'rm -rf /' })
    expect(executed).toEqual(['rm -rf /'])
    const record = root.agentjail?.queryAudit()[0]
    expect(record?.verdict).toBe('deny')
    expect(record?.monitorOnly).toBe(true)
  })

  it('honours the default action when the daemon omits a reason', async () => {
    const { root } = await harness({}, { action: 'allow' })
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(resultText(result)).toContain('ran: ls')
  })

  it('caches verdicts across repeated identical calls', async () => {
    const { root, daemon } = await harness({ cache: { enabled: true, ttlMs: 5000 } })
    await callTool(root, 'bash', { command: 'ls' })
    await callTool(root, 'bash', { command: 'ls' })
    expect(daemon.policyRequests).toHaveLength(1)
  })

  it('does not cache across differing arguments', async () => {
    const { root, daemon } = await harness({ cache: { enabled: true, ttlMs: 5000 } })
    await callTool(root, 'bash', { command: 'ls' })
    await callTool(root, 'bash', { command: 'pwd' })
    expect(daemon.policyRequests).toHaveLength(2)
  })

  it('exposes the service surface for operators', async () => {
    const { root } = await harness()
    const service = root.agentjail
    expect(service).toBeDefined()
    expect(typeof service?.health).toBe('function')
    expect(typeof service?.stats).toBe('function')
    expect(typeof service?.queryAudit).toBe('function')
    expect(typeof service?.report).toBe('function')
    expect(service?.listGrants()).toEqual([])
    expect(service?.alerts()).toEqual([])
  })
})

describe('approval integration', () => {
  it('denies an ask when no approval service is present', async () => {
    const { root, executed } = await harness({}, { action: 'ask', reason: 'review required' })
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual([])
    expect(resultText(result)).toContain('review required')
  })

  it('records the pending digest of a call awaiting an approval', async () => {
    const { root } = await harness({}, { action: 'ask', reason: 'needs approval' })
    await callTool(root, 'bash', { command: 'ls' })
    const digest = root.agentjail?.gate.digestForApproval('call-1', 'bash')
    expect(digest).toBeDefined()
    // The digest is bound to the exact call identity: a different tool or call
    // id must not resolve to it.
    expect(root.agentjail?.gate.digestForApproval('call-1', 'read')).toBeUndefined()
    expect(root.agentjail?.gate.digestForApproval('other-call', 'bash')).toBeUndefined()
  })

  it('allows a call covered by an outstanding grant without asking the engine', async () => {
    const { root, daemon, executed } = await harness({}, { action: 'ask' })
    await callTool(root, 'bash', { command: 'ls' })
    const digest = root.agentjail?.gate.digestForApproval('call-1', 'bash')
    expect(digest).toBeDefined()
    root.agentjail?.grants.issue({
      scope: 'session',
      toolName: 'bash',
      sessionId: 'unscoped',
      digest: digest ?? '',
    })
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual(['ls'])
    expect(resultText(result)).toContain('ran: ls')
    void daemon
  })

  it('issues a grant through the approval hook and reuses it', async () => {
    const { root, daemon, executed } = await harness({}, { action: 'ask' })
    const hook = root.agentjail?.approval
    const grant = root.agentjail?.grants
    expect(hook).toBeDefined()
    expect(grant).toBeDefined()
    // Simulate an interactive answerer approving the exact pending call.
    await callTool(root, 'bash', { command: 'ls' })
    const digest = root.agentjail?.gate.digestForApproval('call-1', 'bash') ?? ''
    const event = {
      agent: { id: 'unscoped' } as never,
      toolName: 'bash',
      callId: 'call-1' as never,
      reason: 'reviewed',
    }
    const outcome = await hook?.answer(event, async () => 'allowed-once')
    expect(outcome).toBe('allowed-once')
    expect(grant?.has({ toolName: 'bash', sessionId: 'unscoped', digest })).toBe(true)
    const result = await callTool(root, 'bash', { command: 'ls' })
    expect(executed).toEqual(['ls'])
    expect(resultText(result)).toContain('ran: ls')
    void daemon
  })

  it('leaves a rejected approval unconsumed', async () => {
    const { root, executed } = await harness({}, { action: 'ask' })
    await callTool(root, 'bash', { command: 'ls' })
    const event = {
      agent: { id: 'unscoped' } as never,
      toolName: 'bash',
      callId: 'call-1' as never,
    }
    const outcome = await root.agentjail?.approval.answer(event, async () => 'rejected')
    expect(outcome).toBe('rejected')
    expect(root.agentjail?.grants.list()).toHaveLength(0)
    expect(executed).toEqual([])
  })

  it('does not issue a grant when the digest is unknown', async () => {
    const { root } = await harness({}, { action: 'ask' })
    const event = {
      agent: { id: 'unscoped' } as never,
      toolName: 'bash',
      callId: 'never-evaluated' as never,
    }
    await root.agentjail?.approval.answer(event, async () => 'allowed-once')
    expect(root.agentjail?.grants.list()).toHaveLength(0)
  })
})
