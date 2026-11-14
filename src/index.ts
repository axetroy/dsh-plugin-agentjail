/**
 * DeepSeek Harness AgentJail security plugin.
 *
 * This plugin routes every agent tool call through the AgentJail policy engine
 * before the call reaches its tool body, and applies the resulting verdict as a
 * `tools/pre-execute` decision. It is the enforcement point that makes an
 * agent's tool surface a policy-governed surface rather than a trusted one.
 *
 * Design invariants, in priority order:
 *
 * 1. **Fail closed.** No path through this plugin turns an unreachable engine, an
 *    unparseable frame, a timeout, or an unexpected exception into an allow. The
 *    failure action is configuration, and its default is `deny`.
 * 2. **One engine.** Rego evaluation stays in AgentJail's OPA engine. The plugin
 *    translates and enforces; it does not re-implement policy.
 * 3. **Everything is recorded.** Every verdict produces one audit record, and the
 *    record names the rule that produced it.
 * 4. **Approvals are narrow.** A grant authorizes exactly one session, tool, and
 *    argument digest. It is consumed on use.
 * @module dsh-plugin-agentjail
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: pulls the `ctx.webServer` service merge and the
// `webserver/index-inject` event into this program without requiring a web
// server at runtime.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config as ConfigSchema, type Config } from './config/schema.js'
import { AgentJailClient, type HealthSnapshot } from './adapter/agentjail-client.js'
import { GrantStore, type Grant } from './security/grants.js'
import { AuditLog, type AuditQuery, type AuditRecord } from './audit/audit-log.js'
import { MetricsCollector, type MetricsSnapshot, type RiskAlert } from './governance/metrics.js'
import {
  buildReport,
  policyDigest,
  renderReport,
  type SecurityReport,
} from './governance/report.js'
import { createPreToolUseGate, type PreToolUseGate } from './hooks/pre-tool-use.js'
import { createPostToolUseObserver, type PostToolUseObserver } from './hooks/post-tool-use.js'
import { createApprovalHook, type ApprovalHook } from './hooks/approval.js'
import { resolveTemplates, writeTemplateBundle } from './security/policy.js'
import type { DecisionAlert } from './security/decision.js'
import {
  DaemonSupervisor,
  defaultManagedDir,
  resolveDaemonBinary,
  type SupervisionState,
} from './adapter/supervisor.js'
import { installManagedBinary } from './adapter/installer.js'
import { currentPackageRoot, resolveRuntimePaths, vendoredDirectory } from './adapter/runtime.js'
import { controlPlanePaths, reloadViaControlPlane } from './adapter/control.js'
import { registerDashboardRoutes, type WebServerLike } from './ui/routes.js'
import { renderDashboardText, type DashboardData } from './ui/dashboard.js'

export const name = 'agentjail'
export const inject = ['tools']

/** The plugin's runtime surface, exposed on the context for operators and tests. */
export interface AgentJailService {
  /** Verdict resolution and enforcement gate. */
  gate: PreToolUseGate
  /** Outcome observer. */
  observer: PostToolUseObserver
  /** Approval answerer. */
  approval: ApprovalHook
  /** Policy engine client. */
  client: AgentJailClient
  /** Issued approvals. */
  grants: GrantStore
  /** Durable audit trail. */
  audit: AuditLog
  /** Risk statistics. */
  metrics: MetricsCollector

  /**
   * Read the current engine health.
   * @returns the latest health snapshot.
   */
  health(): HealthSnapshot
  /**
   * Probe the engine and refresh health.
   * @returns the refreshed health snapshot.
   */
  probeHealth(): Promise<HealthSnapshot>
  /**
   * Read aggregate risk statistics.
   * @returns the current metrics snapshot.
   */
  stats(): MetricsSnapshot
  /**
   * Query the audit trail.
   * @param query - the filter to apply.
   * @returns the matching records, newest first.
   */
  queryAudit(query?: AuditQuery): AuditRecord[]
  /**
   * List outstanding approvals.
   * @returns the live grants.
   */
  listGrants(): Grant[]
  /**
   * Revoke one approval.
   * @param id - the grant identifier.
   * @returns whether a grant was removed.
   */
  revokeGrant(id: string): boolean
  /**
   * Revoke every approval bound to a session.
   * @param sessionId - the session whose approvals are dropped.
   * @returns the number of grants removed.
   */
  revokeSession(sessionId: string): number
  /**
   * Issue a session grant for one call identity.
   *
   * A session grant authorizes repeat calls of the same session, tool, and
   * argument digest until `approval.sessionGrantTtlMs` elapses, which is what a
   * workflow that legitimately repeats one command needs. It is issued through
   * this API rather than from an approval prompt so an operator opts in
   * deliberately; the approval answerer itself only ever issues one-time grants.
   * @param input - the call identity to authorize.
   * @returns the issued grant, or `undefined` when grants are disabled.
   */
  grantSession(input: {
    toolName: string
    sessionId: string
    digest: string
    reason?: string
  }): Grant | undefined
  /**
   * Build a security report.
   * @returns the assembled report.
   */
  report(): SecurityReport
  /**
   * Render a security report as text.
   * @returns the rendered report.
   */
  reportText(): string
  /**
   * Write the configured policy templates to disk.
   * @returns the absolute paths written.
   */
  writePolicyTemplates(): Promise<string[]>
  /**
   * Drop cached verdicts, e.g. after a policy reload.
   */
  invalidateCache(): void
  /**
   * Ask the daemon to reload its policy and drop cached verdicts.
   * @returns the daemon's control result; `ok` is false when it rejected the reload.
   */
  reloadPolicy(): Promise<{ ok: boolean; error?: string; version?: string }>
  /** Alerts observed since plugin load, newest last. */
  alerts(): DecisionAlert[]
  /** What the plugin is currently relying on for policy. */
  supervision(): SupervisionState
  /**
   * Ensure a policy daemon is answering, starting one when none is.
   *
   * A daemon this process did not start is never touched, and the started one
   * is stopped only when it was started here.
   * @returns the supervision outcome after the pass.
   */
  ensureDaemon(): Promise<{ state: SupervisionState; managed: boolean; reason?: string }>
  /**
   * Assemble the dashboard payload.
   * @returns the data the dashboard renders.
   */
  dashboard(): DashboardData
  /**
   * Render the dashboard as plain text.
   * @returns the fixed-width summary.
   */
  dashboardText(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentjail?: AgentJailService
  }
}

/**
 * Read the policy template names a deployment selected.
 * @param config - the validated plugin configuration.
 * @returns the selected template names, without empty entries.
 */
function templateNames(config: Config): string[] {
  return (config.policyContext.attributes['templates'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Options accepted by {@link apply}, beyond the validated config. */
export interface ApplyOptions {
  /**
   * Called for every alert the plugin raises. The default writes a structured
   * line to the logger, so a deployment that collects logs already receives them.
   */
  onAlert?: (alert: DecisionAlert) => void
}

/**
 * Mount the AgentJail security plugin.
 *
 * Registers the `tools/pre-execute` gate, the `tools/post-execute` observer, and
 * — when the approval capability is present — the approval answerer. Every
 * registration is bound to this context's lifetime, so unloading the plugin
 * removes its interception entirely rather than leaving a stale listener.
 * @param ctx - the context to mount into.
 * @param config - the validated plugin configuration.
 * @param options - optional alert sink.
 */
export function apply(ctx: Context, config: Config, options: ApplyOptions = {}): void {
  const logger = ctx.logger
  const alerts: DecisionAlert[] = []
  const emitAlert = (alert: DecisionAlert): void => {
    // `governance.alertsEnabled` gates the whole alert surface. Enforcement and
    // the audit trail are unaffected: turning alerts off silences a signal, it
    // never widens or narrows a verdict.
    if (!config.governance.alertsEnabled) return
    alerts.push(alert)
    while (alerts.length > 200) alerts.shift()
    logger?.info?.('agentjail alert [%s] %s: %s', alert.kind, alert.toolName, alert.message)
    options.onAlert?.(alert)
  }

  // The state directory is derived once and shared by the client, the supervisor,
  // and the control-plane reload, so the socket a daemon binds, the socket the
  // plugin connects to, and the control socket it reloads through always belong
  // to the same daemon.
  const runtimePaths = resolveRuntimePaths(config.daemon.stateDir)
  const packageRoot = currentPackageRoot()
  const vendoredDir = vendoredDirectory(packageRoot ?? runtimePaths.root)
  // By default the plugin runs its own daemon on its own socket, which is what
  // makes installing the plugin sufficient. An explicit `socketPath` (or
  // `AGENTJAIL_SOCKET`) redirects the plugin at a daemon someone else manages.
  const agentSocketPath =
    config.socketPath.length > 0
      ? config.socketPath
      : (process.env['AGENTJAIL_SOCKET'] ?? runtimePaths.socketPath)

  const client = new AgentJailClient({
    socketPath: agentSocketPath,
    timeoutMs: config.timeoutMs,
    reconnectDelayMs: config.reconnectDelayMs,
    maxReconnectDelayMs: config.maxReconnectDelayMs,
    maxRequestBytes: config.maxRequestBytes,
    cache: config.cache,
    fallbackCwd: config.policyContext.attributes['cwd'] ?? process.cwd(),
  })
  const grants = new GrantStore({
    maxGrants: config.approval.maxGrants,
    sessionGrantTtlMs: config.approval.sessionGrantTtlMs,
  })
  const audit = new AuditLog({
    enabled: config.audit.enabled,
    storage: config.audit.storage,
    filePath: config.audit.filePath,
    maxFileBytes: config.audit.maxFileBytes,
    maxRotatedFiles: config.audit.maxRotatedFiles,
    redactSensitiveData: config.audit.redactSensitiveData,
    maxValueChars: config.audit.maxValueChars,
  })
  const metrics = new MetricsCollector({
    windowMs: config.governance.statsWindowMs,
    denyRateAlertThreshold: config.governance.denyRateAlertThreshold,
    denyRateAlertMinSamples: config.governance.denyRateAlertMinSamples,
  })

  const managedDir =
    config.daemon.managedDir.length > 0 ? config.daemon.managedDir : defaultManagedDir()
  const supervisor = new DaemonSupervisor({
    enabled: config.daemon.supervise,
    binary: config.daemon.binary,
    socketPath: agentSocketPath,
    managedDir,
    vendoredDir,
    stateDir: runtimePaths.root,
    args: config.daemon.args,
    startTimeoutMs: config.daemon.startTimeoutMs,
    pollIntervalMs: config.daemon.pollIntervalMs,
    requireSupportedVersion: config.daemon.requireSupportedVersion,
  })

  const gate = createPreToolUseGate(ctx, {
    config,
    client,
    grants,
    audit,
    metrics,
    onAlert: emitAlert,
  })
  const observer = createPostToolUseObserver(ctx, { config, audit })

  ctx.on('tools/pre-execute', async (exec): Promise<PreToolDecision> => {
    return gate.evaluate(exec)
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    observer.observe(exec, result)
    return next()
  })

  if (config.monotonicGuard) {
    ctx.tools.guard((exec): string | undefined => gate.guardReason(exec))
  }

  const approval = createApprovalHook(ctx, {
    config,
    grants,
    audit,
    onAlert: emitAlert,
    digestFor: (event) =>
      event.callId === undefined ? undefined : gate.digestForApproval(event.callId, event.toolName),
  })

  if (ctx.get('approval') !== undefined) {
    ctx.on('approval/request', async (event, next) => approval.answer(event, next))
  } else {
    logger?.info?.('agentjail: no approval service is composed; "ask" verdicts resolve to a denial')
  }

  /** Probe the daemon liveness with a bounded budget. */
  const probeDaemon = async (): Promise<boolean> => {
    const snapshot = await client.probe()
    return snapshot.state === 'healthy'
  }

  /**
   * Download a managed binary when configured and none is installed.
   *
   * This runs only when `daemon.managedInstall` is set, and it is skipped
   * entirely when an `agentjail` binary is already resolvable, so an existing
   * install is never replaced by a download.
   */
  const installManagedBinaryIfConfigured = async (): Promise<void> => {
    if (!config.daemon.managedInstall) return
    const existing = resolveDaemonBinary({
      binary: config.daemon.binary,
      managedDir,
      vendoredDir,
    })
    if (existing !== undefined && existing.source !== 'managed') {
      logger?.info?.('agentjail: using the existing agentjail binary at %s', existing.path)
      return
    }
    if (existing?.source === 'managed') return
    logger?.info?.('agentjail: downloading a managed AgentJail binary into %s', managedDir)
    const result = await installManagedBinary({
      version: config.daemon.managedVersion,
      releaseBaseUrl: config.daemon.releaseBaseUrl,
      managedDir,
      timeoutMs: config.daemon.downloadTimeoutMs,
      maxArchiveBytes: config.daemon.maxArchiveBytes,
    })
    if (result.installed) {
      logger?.info?.('agentjail: installed managed binary %s', result.path ?? managedDir)
    } else {
      logger?.warn?.(
        'agentjail: managed install did not complete (%s); continuing without it',
        result.reason ?? 'unknown reason',
      )
    }
  }

  /** Assemble the dashboard payload from the live plugin state. */
  const collectDashboard = (): DashboardData => ({
    health: client.snapshot(),
    stats: metrics.snapshot(),
    records: audit.query({ limit: config.ui.recordLimit }),
    grants: grants.list(),
    alerts: [...alerts],
    supervision: supervisor.current,
    enforcement: config.enforcement,
    failureAction: config.failureAction,
    defaultAction: config.defaultAction,
    now: new Date().toISOString(),
  })

  const service: AgentJailService = {
    gate,
    observer,
    approval,
    client,
    grants,
    audit,
    metrics,
    health: () => client.snapshot(),
    probeHealth: () => client.probe(),
    stats: () => metrics.snapshot(),
    queryAudit: (query) => audit.query(query),
    listGrants: () => grants.list(),
    revokeGrant: (id) => grants.revoke(id),
    revokeSession: (sessionId) => grants.revokeSession(sessionId),
    grantSession: (input) => {
      if (!config.approval.grantsEnabled) return undefined
      const grant = grants.issue({
        scope: 'session',
        toolName: input.toolName,
        sessionId: input.sessionId,
        digest: input.digest,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      })
      void audit
        .record({
          requestId: grant.id,
          sessionId: input.sessionId,
          agentId: input.sessionId,
          toolName: input.toolName,
          jailToolName: input.toolName,
          cwd: config.policyContext.attributes['cwd'] ?? process.cwd(),
          verdict: 'allow',
          source: 'grant',
          arguments: {},
          digest: input.digest,
          durationMs: 0,
          reason: `session grant issued for "${input.toolName}"`,
          grantId: grant.id,
        })
        .catch((error: unknown) =>
          logger?.warn?.(
            'agentjail: failed to record a session grant: %s',
            error instanceof Error ? error.message : String(error),
          ),
        )
      logger?.info?.(
        'agentjail: session grant issued for "%s" in session "%s"',
        input.toolName,
        input.sessionId,
      )
      return grant
    },
    report: () =>
      buildReport({
        options: {
          title: 'DeepSeek Harness AgentJail security report',
          includePolicyDigest: config.governance.includePolicyDigest,
          recentLimit: 100,
        },
        metrics,
        audit,
        health: client.snapshot(),
        grants: grants.list(),
        ...(config.governance.includePolicyDigest
          ? {
              policy: policyDigest({
                enforcement: config.enforcement,
                failureAction: config.failureAction,
                defaultAction: config.defaultAction,
                askAction: config.askAction,
                exemptions: [...config.exemptTools, ...config.exemptToolPrefixes],
                overrideKeys: [
                  ...Object.keys(config.overrides.agents).map((key) => `agent:${key}`),
                  ...Object.keys(config.overrides.sessions).map((key) => `session:${key}`),
                  ...Object.keys(config.overrides.tools).map((key) => `tool:${key}`),
                ],
                cacheEnabled: config.cache.enabled,
              }),
            }
          : {}),
      }),
    reportText: () => renderReport(service.report()),
    writePolicyTemplates: async () => {
      const names = templateNames(config)
      if (names.length === 0) return []
      const templates = resolveTemplates(names)
      const directory =
        config.policyContext.attributes['templateDirectory'] ?? '/etc/agentjail/policies'
      return writeTemplateBundle(directory, templates)
    },
    invalidateCache: () => client.invalidate(),
    reloadPolicy: async () => {
      // Reload is served only on the daemon's privileged control socket, never on
      // the agent socket the client pools.
      //
      // Only a daemon this plugin started is reloaded. An adopted daemon belongs
      // to the operator, and its control plane is whatever happens to sit under
      // the process `HOME` - which is not necessarily the daemon the client is
      // talking to. Reloading a daemon the plugin does not own, or the wrong one,
      // is worse than reporting that it could not reload, so an adopted daemon is
      // reported instead.
      if (supervisor.current !== 'started') {
        return {
          ok: false,
          error:
            'policy reload is available only for a daemon this plugin started; the configured daemon is managed elsewhere',
        }
      }
      const result = await reloadViaControlPlane(
        controlPlanePaths(runtimePaths.home),
        config.timeoutMs,
      )
      if (result.ok) {
        client.invalidate()
        return { ok: true }
      }
      // The control plane was unreachable or refused. Restarting the managed
      // daemon reloads policy as a side effect of starting it.
      if (supervisor.restart() !== undefined) {
        const ready = await probeDaemon()
        if (ready) {
          client.invalidate()
          logger?.info?.('agentjail: policy reloaded by restarting the managed daemon')
          return { ok: true }
        }
      }
      return { ok: false, ...(result.error !== undefined ? { error: result.error } : {}) }
    },
    alerts: () => [...alerts],
    supervision: () => supervisor.current,
    ensureDaemon: async () => {
      await installManagedBinaryIfConfigured()
      const outcome = await supervisor.ensure(() => probeDaemon())
      if (outcome.state === 'started') {
        logger?.info?.('agentjail: started a policy daemon via %s', outcome.binary?.path ?? '?')
      } else if (outcome.state === 'external') {
        logger?.info?.('agentjail: using the daemon already running at %s', client.socketPath)
      } else if (outcome.state === 'incompatible') {
        logger?.error?.(
          'agentjail: refusing to start an unsupported AgentJail build (%s); applying the configured failure action "%s"',
          outcome.reason ?? 'unknown version',
          config.failureAction,
        )
      } else if (outcome.reason !== undefined) {
        logger?.warn?.(
          'agentjail: no policy daemon available (%s); applying the configured failure action "%s"',
          outcome.reason,
          config.failureAction,
        )
      }
      return {
        state: outcome.state,
        managed: outcome.managed,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      }
    },
    dashboard: () => collectDashboard(),
    dashboardText: () => renderDashboardText(collectDashboard()),
  }
  ctx.provide('agentjail', service)

  // Render configured policy templates at load, so a deployment that names them
  // in `policyContext.attributes.templates` does not need a separate step. An
  // unknown template name throws, which surfaces as a load error rather than a
  // silently weaker policy.
  if (templateNames(config).length > 0) {
    void service.writePolicyTemplates().then(
      (written) => logger?.info?.('agentjail: wrote %d policy template file(s)', written.length),
      (error: unknown) =>
        logger?.warn?.(
          'agentjail: could not write policy templates: %s',
          error instanceof Error ? error.message : String(error),
        ),
    )
  }

  // The dashboard data routes are registered only when a web server is
  // composed. A headless deployment, the CLI, and the desktop app have none,
  // and that is not an error: the enforcement path does not depend on any of
  // this. The section itself is contributed by the browser half through the
  // client slot system; the Host only supplies its data and the small global
  // row that tells it where that data lives.
  if (config.ui.enabled) {
    const webServer = ctx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) {
      logger?.info?.('agentjail: no web server is composed; the security panel is not served')
    } else {
      const disposeRoutes = registerDashboardRoutes(webServer, {
        basePath: config.ui.basePath,
        collect: () => collectDashboard(),
        recordLimit: config.ui.recordLimit,
      })
      ctx.effect(() => disposeRoutes)
      ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: '__AGENTJAIL_UI__',
          value: { basePath: config.ui.basePath, refreshMs: config.ui.refreshMs },
        })
      })
      logger?.info?.('agentjail: security panel data served at %s', config.ui.basePath)
    }
  }

  // Fill the gap where AgentJail is installed but nothing has started its
  // daemon. A daemon that is already answering is left alone, and only a daemon
  // this process started is stopped on unload.
  if (config.daemon.supervise) {
    void service.ensureDaemon()
  }

  if (config.healthCheckOnLoad) {
    void client.probe().then((snapshot) => {
      if (snapshot.state === 'healthy') {
        logger?.info?.('agentjail: policy engine healthy at %s', snapshot.socketPath)
      } else {
        logger?.warn?.(
          'agentjail: policy engine is %s at %s; applying the configured failure action "%s"',
          snapshot.state,
          snapshot.socketPath,
          config.failureAction,
        )
      }
    })
  }

  if (config.healthCheckIntervalMs > 0) {
    const timer = setInterval(() => {
      void client.probe().then((snapshot) => {
        if (snapshot.state !== 'healthy') {
          logger?.warn?.(
            'agentjail: policy engine health is %s: %s',
            snapshot.state,
            snapshot.lastError ?? '',
          )
        }
      })
    }, config.healthCheckIntervalMs)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  ctx.effect(() => async () => {
    // Only a daemon this process started is signalled; an operator-managed one
    // keeps running so another session keeps its protection.
    supervisor.stop()
    client.close()
    // Let queued audit appends land before the fiber is gone, so an unload
    // followed immediately by process exit does not drop the last records.
    await audit.flush()
  })

  logger?.info?.(
    'agentjail: mounted in %s mode; socket=%s failure=%s default=%s',
    config.enforcement,
    client.socketPath,
    config.failureAction,
    config.defaultAction,
  )
}

export { ConfigSchema }
export type { Config, ToolExecution, ToolExecutionResult, RiskAlert }
