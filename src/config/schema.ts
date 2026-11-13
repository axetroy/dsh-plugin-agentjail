/**
 * Plugin configuration schema.
 *
 * Every value a deployment may need to tune is a configuration field, so
 * `cordis.yml` can change behavior without a code edit. Defaults are chosen to
 * fail closed: an unknown or unreachable verdict never becomes an allow.
 * @module dsh-plugin-agentjail/config
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_RELEASE_BASE_URL } from '../adapter/installer.js'

/** Verdict the plugin applies when the policy engine cannot return a trusted answer. */
export type FailureAction = 'deny' | 'ask' | 'allow'

/** How a plugin-level `ask` verdict is enforced when no approval answerer is reachable. */
export type AskFallback = 'deny' | 'native'

/** Audit sink target. */
export type AuditStorage = 'file' | 'memory' | 'none'

/** Per-scope (agent / session / tool) policy override entry. */
export interface ScopeOverride {
  /** Override decision for calls matched by this entry's key pattern. */
  action: 'allow' | 'deny' | 'ask'
  /** Optional human-readable reason recorded with the decision. */
  reason?: string
}

/** Serialized shape of `policyContext` handed to AgentJail's request attributes. */
export interface PolicyContextConfig {
  /** Extra static key/value attributes attached to every policy request. */
  attributes: Record<string, string>
}

/** Daemon supervision and managed-install settings. */
export interface DaemonConfig {
  /**
   * Start an AgentJail daemon when none is answering.
   *
   * A daemon that is already running — started by systemd, launchd, or the
   * official installer — is never touched. This only fills the gap where no
   * daemon answers at the configured socket.
   */
  supervise: boolean
  /** Explicit `agentjail` binary path. Empty falls back to `AGENTJAIL_BIN`, then `PATH`. */
  binary: string
  /** Arguments used to start the daemon. */
  args: string[]
  /** Directory holding plugin-managed daemon state. Empty uses the per-user default. */
  stateDir: string
  /**
   * Refuse to start an `agentjail` binary whose version is outside the window
   * this plugin release was verified against. On by default: a build the plugin
   * has not been tested with is exactly the case that breaks silently.
   */
  requireSupportedVersion: boolean
  /** How long to wait for a started daemon to answer, in milliseconds. */
  startTimeoutMs: number
  /** Delay between readiness probes while waiting for a started daemon. */
  pollIntervalMs: number
  /**
   * Download and install an AgentJail binary when none is found. Off by default:
   * fetching and executing a release binary is the operator's trust decision.
   */
  managedInstall: boolean
  /** Release tag to install, e.g. `v1.8.2`. Empty uses the latest release. */
  managedVersion: string
  /** Base URL serving `<base>/<tag>/<asset>`. */
  releaseBaseUrl: string
  /** Directory a managed binary is installed into. Empty uses the per-user default. */
  managedDir: string
  /** Download budget in milliseconds. */
  downloadTimeoutMs: number
  /** Maximum accepted archive size in bytes. */
  maxArchiveBytes: number
}

/** Dashboard settings. */
export interface UiConfig {
  /** Serve the dashboard when a Harness web server is composed. */
  enabled: boolean
  /** Base path the dashboard is served from. */
  basePath: string
  /** Browser page refresh interval in milliseconds; `0` disables it. */
  refreshMs: number
  /** Maximum audit records the JSON endpoint returns. */
  recordLimit: number
}

/** Plugin configuration. */
export interface Config {
  /**
   * Enforcement mode. `monitor` records verdicts without blocking (audit only);
   * `enforce` applies the verdict to the tool pipeline.
   */
  enforcement: 'enforce' | 'monitor'
  /** Absolute path to the AgentJail daemon Unix socket. Empty uses `~/.agentjail/daemon.sock`. */
  socketPath: string
  /** Per-request policy evaluation budget in milliseconds. */
  timeoutMs: number
  /** Delay before the first reconnect attempt after a socket failure, in milliseconds. */
  reconnectDelayMs: number
  /** Maximum reconnect backoff, in milliseconds. */
  maxReconnectDelayMs: number
  /** Whether to perform a `control/ping` health probe on plugin load. */
  healthCheckOnLoad: boolean
  /** Interval for background health probes, in milliseconds. `0` disables them. */
  healthCheckIntervalMs: number
  /**
   * Verdict applied when the engine is unreachable, times out, or returns a
   * malformed/unrecognized answer. Never default this to `allow`.
   */
  failureAction: FailureAction
  /** Verdict applied when the engine answers with an explicit `ask`. */
  askAction: 'ask' | 'deny'
  /**
   * How `ask` is resolved. `native` hands the decision to Harness's approval
   * service (one-shot human grant); `deny` fails closed when unavailable.
   */
  askFallback: AskFallback
  /** Verdict applied to a call that matches no rule and no override. */
  defaultAction: 'allow' | 'deny' | 'ask'
  /** Tool names exempt from policy checks. Keep this list empty in production. */
  exemptTools: string[]
  /** Tool name prefixes exempt from policy checks (e.g. `mcp__trusted__`). */
  exemptToolPrefixes: string[]
  /**
   * When true, a `tools/pre-execute` listener registered as a monotonic guard
   * re-checks the cached verdict, so a later listener cannot re-open a denial.
   */
  monotonicGuard: boolean
  /** Whether to keep a bounded decision cache to avoid re-asking the daemon. */
  cache: {
    enabled: boolean
    maxEntries: number
    ttlMs: number
  }
  /** Maximum serialized request body size in bytes; larger requests fail closed. */
  maxRequestBytes: number
  /** Audit log settings. */
  audit: {
    enabled: boolean
    storage: AuditStorage
    /** File path used when `storage` is `file`. */
    filePath: string
    /** Rotate the audit file once it exceeds this size in bytes. `0` disables rotation. */
    maxFileBytes: number
    /** Number of rotated files to retain. */
    maxRotatedFiles: number
    /** Redact sensitive argument values before they reach any sink. */
    redactSensitiveData: boolean
    /** Maximum characters of each redacted argument value kept in the record. */
    maxValueChars: number
  }
  /** Per-scope policy overrides applied before the engine verdict. */
  overrides: {
    /** Overrides keyed by agent id. */
    agents: Record<string, ScopeOverride>
    /** Overrides keyed by session id. */
    sessions: Record<string, ScopeOverride>
    /** Overrides keyed by tool name. */
    tools: Record<string, ScopeOverride>
  }
  /** Approval grant lifetime and reuse policy. */
  approval: {
    /** Enable one-time and session grants so an approved call is not re-prompted. */
    grantsEnabled: boolean
    /** Session grant lifetime in milliseconds. */
    sessionGrantTtlMs: number
    /** Maximum outstanding grants retained in memory. */
    maxGrants: number
  }
  /** Enterprise governance settings. */
  governance: {
    /** Emit a structured security event when a verdict is deny or ask. */
    alertsEnabled: boolean
    /** Emit an alert when the deny ratio over the sample window exceeds this value. */
    denyRateAlertThreshold: number
    /** Minimum decisions before the deny-rate alert can fire. */
    denyRateAlertMinSamples: number
    /** Sliding window length in milliseconds for risk statistics. */
    statsWindowMs: number
    /** Include a policy distribution digest in generated reports. */
    includePolicyDigest: boolean
  }
  /** Extra attributes attached to every policy evaluation request. */
  policyContext: PolicyContextConfig
  /** Daemon supervision and managed-install settings. */
  daemon: DaemonConfig
  /** Dashboard settings. */
  ui: UiConfig
}

const scopeOverride = Schema.object({
  action: Schema.union(['allow', 'deny', 'ask'] as const).required(),
  reason: Schema.string(),
})

/** Configuration schema with defaults; Cordis validates it while loading the plugin. */
export const Config: Schema<Config> = Schema.object({
  enforcement: Schema.union(['enforce', 'monitor'] as const)
    .default('enforce')
    .description('Apply verdicts to the tool pipeline, or record them in monitor mode.'),
  socketPath: Schema.string()
    .default('')
    .description(
      'Absolute path to the AgentJail daemon socket; empty uses ~/.agentjail/daemon.sock.',
    ),
  timeoutMs: Schema.number()
    .default(2000)
    .min(1)
    .description('Per-request policy evaluation budget in milliseconds.'),
  reconnectDelayMs: Schema.number()
    .default(200)
    .min(0)
    .description('Delay before the first reconnect attempt after a socket failure.'),
  maxReconnectDelayMs: Schema.number()
    .default(5000)
    .min(0)
    .description('Maximum reconnect backoff in milliseconds.'),
  healthCheckOnLoad: Schema.boolean()
    .default(true)
    .description('Probe the daemon with a control ping while the plugin loads.'),
  healthCheckIntervalMs: Schema.number()
    .default(30000)
    .min(0)
    .description('Background health probe interval in milliseconds; 0 disables it.'),
  failureAction: Schema.union(['deny', 'ask', 'allow'] as const)
    .default('deny')
    .description('Verdict used when no trusted answer is available.'),
  askAction: Schema.union(['ask', 'deny'] as const)
    .default('ask')
    .description('Verdict applied to an explicit engine ask.'),
  askFallback: Schema.union(['deny', 'native'] as const)
    .default('native')
    .description('Resolve ask through the Harness approval service, or fail closed.'),
  defaultAction: Schema.union(['allow', 'deny', 'ask'] as const)
    .default('deny')
    .description('Verdict for a call that matches no rule and no override.'),
  exemptTools: Schema.array(Schema.string())
    .default([])
    .description('Tool names that bypass policy checks.'),
  exemptToolPrefixes: Schema.array(Schema.string())
    .default([])
    .description('Tool name prefixes that bypass policy checks.'),
  monotonicGuard: Schema.boolean()
    .default(true)
    .description(
      'Re-assert denials through a monotonic guard so later listeners cannot re-open them.',
    ),
  cache: Schema.object({
    enabled: Schema.boolean().default(true).description('Cache engine verdicts.'),
    maxEntries: Schema.number().default(1024).min(1).description('Maximum cached verdicts.'),
    ttlMs: Schema.number()
      .default(5000)
      .min(0)
      .description('Cached verdict lifetime in milliseconds.'),
  }).default({}),
  maxRequestBytes: Schema.number()
    .default(262144)
    .min(1024)
    .description('Maximum serialized policy request size; larger requests fail closed.'),
  audit: Schema.object({
    enabled: Schema.boolean().default(true).description('Record an audit entry per decision.'),
    storage: Schema.union(['file', 'memory', 'none'] as const)
      .default('file')
      .description('Audit sink.'),
    filePath: Schema.string()
      .default('')
      .description('Audit file path; empty uses ~/.agentjail/dsh-audit.jsonl.'),
    maxFileBytes: Schema.number()
      .default(8388608)
      .min(0)
      .description('Rotate the audit file past this size; 0 disables rotation.'),
    maxRotatedFiles: Schema.number().default(5).min(0).description('Rotated files to retain.'),
    redactSensitiveData: Schema.boolean()
      .default(true)
      .description('Redact sensitive argument values before writing an audit record.'),
    maxValueChars: Schema.number()
      .default(256)
      .min(0)
      .description('Maximum characters retained per redacted argument value.'),
  }).default({}),
  overrides: Schema.object({
    agents: Schema.dict(scopeOverride).default({}),
    sessions: Schema.dict(scopeOverride).default({}),
    tools: Schema.dict(scopeOverride).default({}),
  }).default({}),
  approval: Schema.object({
    grantsEnabled: Schema.boolean()
      .default(true)
      .description('Reuse an approval for its exact call identity instead of re-prompting.'),
    sessionGrantTtlMs: Schema.number()
      .default(3600000)
      .min(0)
      .description('Session grant lifetime in milliseconds.'),
    maxGrants: Schema.number().default(512).min(1).description('Maximum retained grants.'),
  }).default({}),
  governance: Schema.object({
    alertsEnabled: Schema.boolean()
      .default(true)
      .description('Emit alerts on deny and ask verdicts.'),
    denyRateAlertThreshold: Schema.number()
      .default(0.5)
      .min(0)
      .max(1)
      .description('Deny ratio that raises a risk alert.'),
    denyRateAlertMinSamples: Schema.number()
      .default(20)
      .min(1)
      .description('Minimum decisions before a deny-rate alert may fire.'),
    statsWindowMs: Schema.number()
      .default(300000)
      .min(1000)
      .description('Sliding risk-statistics window in milliseconds.'),
    includePolicyDigest: Schema.boolean()
      .default(true)
      .description('Include the policy digest in generated reports.'),
  }).default({}),
  policyContext: Schema.object({
    attributes: Schema.dict(Schema.string()).default({}),
  }).default({}),
  daemon: Schema.object({
    supervise: Schema.boolean()
      .default(true)
      .description('Start an AgentJail daemon when none is answering.'),
    binary: Schema.string()
      .default('')
      .description('Explicit agentjail binary path; empty falls back to AGENTJAIL_BIN then PATH.'),
    args: Schema.array(Schema.string())
      .default(['daemon'])
      .description('Arguments used to start the daemon.'),
    stateDir: Schema.string()
      .default('')
      .description(
        'Directory holding the plugin-managed daemon state; empty uses the per-user default.',
      ),
    requireSupportedVersion: Schema.boolean()
      .default(true)
      .description(
        'Refuse to start an agentjail binary whose version is outside the supported window.',
      ),
    startTimeoutMs: Schema.number()
      .default(10000)
      .min(100)
      .description('How long to wait for a started daemon to answer.'),
    pollIntervalMs: Schema.number()
      .default(250)
      .min(10)
      .description('Delay between readiness probes while waiting for a started daemon.'),
    managedInstall: Schema.boolean()
      .default(false)
      .description('Download and install an AgentJail binary when none is found.'),
    managedVersion: Schema.string()
      .default('')
      .description('Release tag to install; empty uses the latest release.'),
    releaseBaseUrl: Schema.string()
      .default(DEFAULT_RELEASE_BASE_URL)
      .description('Base URL serving release assets.'),
    managedDir: Schema.string()
      .default('')
      .description(
        'Directory a managed binary is installed into; empty uses the per-user default.',
      ),
    downloadTimeoutMs: Schema.number()
      .default(120000)
      .min(1000)
      .description('Download budget in milliseconds.'),
    maxArchiveBytes: Schema.number()
      .default(67108864)
      .min(1048576)
      .description('Maximum accepted archive size in bytes.'),
  }).default({}),
  ui: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('Serve the dashboard when a Harness web server is composed.'),
    basePath: Schema.string()
      .default('/agentjail')
      .description('Base path the dashboard is served from.'),
    refreshMs: Schema.number()
      .default(5000)
      .min(0)
      .description('Browser page refresh interval; 0 disables it.'),
    recordLimit: Schema.number()
      .default(200)
      .min(1)
      .description('Maximum audit records the JSON endpoint returns.'),
  }).default({}),
})
