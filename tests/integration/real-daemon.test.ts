/**
 * End-to-end tests against a real, vendored AgentJail daemon.
 *
 * Everything else in the suite stands in for the daemon. These do not: they run
 * the actual binary, let it bind a real socket, and route real tool calls through
 * its real OPA engine. That is the only way to prove the claims that matter -
 * that the plugin starts the daemon it shipped, that the flags it passes land the
 * daemon on the socket the plugin connects to, and that a genuine policy verdict
 * reaches a tool call.
 *
 * The suite is skipped unless `AGENTJAIL_E2E=1` and a vendored binary is present,
 * so an ordinary checkout without a vendored build stays green.
 * @module tests/integration/real-daemon
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../../src/index.js'
import { Config } from '../../src/config/schema.js'
import { DaemonSupervisor, checkBinaryVersion } from '../../src/adapter/supervisor.js'
import {
  currentPackageRoot,
  daemonEnvironment,
  resolveRuntimePaths,
  vendoredBinaryPath,
} from '../../src/adapter/runtime.js'

/** The vendored binary for this platform, or `undefined` when none is present. */
function vendoredBinary(): string | undefined {
  const root = currentPackageRoot()
  return root === undefined ? undefined : vendoredBinaryPath(root)
}

const binary = vendoredBinary()
const enabled = process.env['AGENTJAIL_E2E'] === '1' && binary !== undefined

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A private state directory for one test. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentjail-e2e-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe.skipIf(!enabled)('real vendored daemon', () => {
  it('starts the vendored binary on the socket the plugin was configured with', async () => {
    const stateDir = await scratch()
    const paths = resolveRuntimePaths(stateDir)
    const supervisor = new DaemonSupervisor({
      enabled: true,
      binary: '',
      socketPath: paths.socketPath,
      managedDir: '/nonexistent',
      vendoredDir: join(currentPackageRoot() ?? '', 'vendor', 'unused'),
      stateDir,
      args: ['daemon'],
      startTimeoutMs: 15_000,
      pollIntervalMs: 250,
      requireSupportedVersion: true,
    })
    cleanups.push(() => void supervisor.stop())

    // Point the resolver at the real vendored build by using it as the configured
    // binary, so the test does not depend on the checkout's vendor directory.
    const withBinary = new DaemonSupervisor({
      enabled: true,
      binary: binary ?? '',
      socketPath: paths.socketPath,
      managedDir: '/nonexistent',
      vendoredDir: '/nonexistent',
      stateDir,
      args: ['daemon'],
      startTimeoutMs: 15_000,
      pollIntervalMs: 250,
      requireSupportedVersion: true,
    })
    cleanups.push(() => void withBinary.stop())

    const outcome = await withBinary.ensure(async () => existsSync(paths.socketPath))
    expect(outcome.state).toBe('started')
    expect(outcome.managed).toBe(true)
    expect(withBinary.version?.compatibility).toBe('ok')
    // The daemon bound the socket the plugin asked for, not its own default.
    expect(existsSync(paths.socketPath)).toBe(true)
  }, 30_000)

  it('answers a real policy evaluation over the socket', async () => {
    const stateDir = await scratch()
    const paths = resolveRuntimePaths(stateDir)
    const supervisor = new DaemonSupervisor({
      enabled: true,
      binary: binary ?? '',
      socketPath: paths.socketPath,
      managedDir: '/nonexistent',
      vendoredDir: '/nonexistent',
      stateDir,
      args: ['daemon'],
      startTimeoutMs: 15_000,
      pollIntervalMs: 250,
      requireSupportedVersion: true,
    })
    cleanups.push(() => void supervisor.stop())
    const outcome = await supervisor.ensure(async () => existsSync(paths.socketPath))
    expect(outcome.state).toBe('started')

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

    apply(
      root,
      Config({
        socketPath: paths.socketPath,
        timeoutMs: 5000,
        audit: { storage: 'memory' },
        failureAction: 'deny',
      } as never),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    // `rm -rf /` is denied by AgentJail's own default command policy, so a real
    // verdict reaching a real tool call proves the whole path.
    const verdict = await root.agentjail?.client.evaluateCall({
      toolName: 'bash',
      arguments: { command: 'rm -rf /' },
      sessionId: 'e2e',
      cwd: stateDir,
    })
    expect(verdict?.decision?.action).toBe('deny')
    expect(verdict?.decision?.ruleId).toBeDefined()

    // A benign read is allowed, which shows the engine is evaluating rather than
    // denying everything.
    const allowed = await root.agentjail?.client.evaluateCall({
      toolName: 'bash',
      arguments: { command: 'ls -la' },
      sessionId: 'e2e',
      cwd: stateDir,
    })
    expect(allowed?.decision?.action).toBe('allow')
  }, 30_000)

  it('reloads policy over the control socket of a daemon it started', async () => {
    const stateDir = await scratch()
    const paths = resolveRuntimePaths(stateDir)
    const root = new Context()
    root.plugin(SystemPrompt)
    root.plugin(NativeExecutor)
    root.plugin(ToolsService)
    await new Promise((resolve) => setTimeout(resolve, 50))
    cleanups.push(() => root.fiber.dispose())

    // The plugin starts the vendored binary itself, so the daemon is one it
    // manages and its control plane is the one under the private HOME.
    apply(
      root,
      Config({
        socketPath: paths.socketPath,
        timeoutMs: 5000,
        audit: { storage: 'memory' },
        daemon: {
          supervise: true,
          binary: binary ?? '',
          stateDir,
          startTimeoutMs: 15_000,
          pollIntervalMs: 250,
        },
      } as never),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const outcome = await root.agentjail?.ensureDaemon()
    expect(outcome?.state).toBe('started')
    cleanups.push(() => root.agentjail?.client.close())

    const result = await root.agentjail?.reloadPolicy()
    expect(result?.ok).toBe(true)
  }, 30_000)

  it('reports the vendored binary version', () => {
    const output = execFileSync(binary ?? 'agentjail', ['--no-color', 'version'], {
      encoding: 'utf8',
    })
    expect(output).toMatch(/v\d+\.\d+\.\d+/)
  })

  it('reports a version the plugin accepts', async () => {
    const check = await checkBinaryVersion(binary ?? 'agentjail')
    expect(check.compatibility).toBe('ok')
    expect(check.version?.raw).toBeDefined()
  })

  it('gives the daemon an environment that keeps it out of the operator HOME', () => {
    const paths = resolveRuntimePaths('/state/root')
    const env = daemonEnvironment(paths)
    expect(env['HOME']).toBe(paths.home)
  })
})
