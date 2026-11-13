/**
 * Audit trail.
 *
 * Every evaluation produces exactly one durable record, whatever its outcome:
 * allow, deny, ask, a grant reuse, or a transport failure. Records are the
 * evidence an operator reads when asked why an agent did or did not do
 * something, so a write failure is surfaced rather than swallowed.
 *
 * Records are newline-delimited JSON. Sensitive argument values are redacted
 * before they reach any sink.
 * @module dsh-plugin-agentjail/audit/audit-log
 */

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { redactValue } from '../security/sanitizer.js'
import { stableStringify } from '../utils/request-id.js'

/** Why a decision was reached, independent of what it was. */
export type DecisionSource =
  'engine' | 'cache' | 'override' | 'exempt' | 'default' | 'grant' | 'failure-action'

/** The verdict applied to one tool call. */
export type AuditVerdict = 'allow' | 'deny' | 'ask'

/** One durable audit record. */
export interface AuditRecord {
  /** Record schema version, so older records stay readable after a format change. */
  version: 1
  /** Monotonic sequence number within this process. */
  seq: number
  /** ISO-8601 timestamp of the decision. */
  timestamp: string
  /** Stable request id correlating this record with the daemon exchange. */
  requestId: string
  /** Session the call belongs to. */
  sessionId: string
  /** Agent the call belongs to. */
  agentId: string
  /** Harness tool name as registered on `ctx.tools`. */
  toolName: string
  /** AgentJail tool name after normalization. */
  jailToolName: string
  /** Working directory the call resolved against. */
  cwd: string
  /** Verdict the plugin applied. */
  verdict: AuditVerdict
  /** What produced the verdict. */
  source: DecisionSource
  /** Rule that produced the verdict, when the engine named one. */
  ruleId?: string
  /** Human-readable justification. */
  reason?: string
  /** Redacted tool arguments. */
  arguments: unknown
  /** Argument digest binding the verdict to the exact arguments. */
  digest: string
  /** Evaluation duration in milliseconds. */
  durationMs: number
  /** Error code when the verdict came from a failure action. */
  errorCode?: string
  /** Error message when the verdict came from a failure action. */
  errorMessage?: string
  /** Consequence-of-allowing text, when the engine supplied one. */
  impact?: string
  /** Verdict the daemon declined to act on because it is monitoring. */
  wouldAction?: string
  /** Whether the call ran in monitor mode and was therefore not blocked. */
  monitorOnly?: boolean
  /** Identifier of the grant that authorized the call, when one was reused. */
  grantId?: string
}

/** Audit sink configuration. */
export interface AuditOptions {
  enabled: boolean
  storage: 'file' | 'memory' | 'none'
  filePath: string
  maxFileBytes: number
  maxRotatedFiles: number
  redactSensitiveData: boolean
  maxValueChars: number
}

/** A query over retained in-memory records. */
export interface AuditQuery {
  /** Only records for this session. */
  sessionId?: string
  /** Only records for this tool. */
  toolName?: string
  /** Only records with this verdict. */
  verdict?: AuditVerdict
  /** Only records at or after this epoch-millisecond time. */
  since?: number
  /** Maximum records returned. */
  limit?: number
}

/**
 * Resolve the default audit file path.
 *
 * `AGENTJAIL_DSH_AUDIT_PATH` overrides the per-user default, so a deployment
 * can point the trail at a mounted volume without editing the plugin config.
 * @returns the absolute audit file path.
 */
export function defaultAuditPath(): string {
  const fromEnvironment = process.env['AGENTJAIL_DSH_AUDIT_PATH']
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment
  const home = process.env['HOME'] ?? homedir()
  return join(home, '.agentjail', 'dsh-audit.jsonl')
}

/**
 * Append-only audit log with size-based rotation.
 *
 * The file sink is best-effort and non-blocking with respect to the decision:
 * a failed append is reported to the caller, which records it once and keeps
 * serving. The in-memory ring is always maintained when auditing is enabled, so
 * queries work even when the file sink is unavailable.
 */
export class AuditLog {
  private readonly records: AuditRecord[] = []
  private seq = 0
  private writeChain: Promise<void> = Promise.resolve()
  private lastError: string | undefined

  constructor(
    private readonly options: AuditOptions,
    private readonly maxMemoryRecords = 1000,
  ) {}

  /** The resolved audit file path, or `undefined` when the file sink is off. */
  get filePath(): string | undefined {
    if (!this.options.enabled || this.options.storage !== 'file') return undefined
    return this.options.filePath.length > 0 ? this.options.filePath : defaultAuditPath()
  }

  /** Message from the most recent failed append, if any. */
  get error(): string | undefined {
    return this.lastError
  }

  /**
   * Record one decision and return the stored record.
   *
   * The record is assigned its sequence number and timestamp here, so callers
   * never have to supply either and records stay ordered.
   * @param input - the decision fields to record.
   * @returns the stored record, or `undefined` when auditing is disabled.
   */
  record(
    input: Omit<AuditRecord, 'version' | 'seq' | 'timestamp' | 'arguments'> & {
      arguments: unknown
    },
  ): Promise<AuditRecord | undefined> {
    if (!this.options.enabled || this.options.storage === 'none') {
      return Promise.resolve(undefined)
    }
    this.seq += 1
    const record: AuditRecord = {
      ...input,
      version: 1,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      arguments: this.redact(input.arguments),
    }
    this.records.push(record)
    while (this.records.length > this.maxMemoryRecords) this.records.shift()
    if (this.options.storage === 'file') this.enqueueWrite(record)
    return Promise.resolve(record)
  }

  /** Redact arguments when configured to do so. */
  private redact(arguments_: unknown): unknown {
    if (!this.options.redactSensitiveData) return arguments_
    return redactValue(arguments_, { maxValueChars: this.options.maxValueChars })
  }

  /** Serialize one record to a file append, chained to keep line order stable. */
  private enqueueWrite(record: AuditRecord): void {
    const path = this.filePath
    if (path === undefined) return
    const line = `${stableStringify(record)}\n`
    this.writeChain = this.writeChain
      .then(() => this.writeLine(path, line))
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
      })
  }

  /** Create the parent directory, rotate when needed, and append one line. */
  private async writeLine(path: string, line: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await this.maybeRotate(path, Buffer.byteLength(line, 'utf8'))
    await appendFile(path, line, { mode: 0o600 })
    this.lastError = undefined
  }

  /** Rotate the audit file when appending would exceed the configured ceiling. */
  private async maybeRotate(path: string, incoming: number): Promise<void> {
    if (this.options.maxFileBytes <= 0) return
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return
    }
    if (size + incoming <= this.options.maxFileBytes) return
    const generations = this.options.maxRotatedFiles
    if (generations <= 0) {
      await unlink(path).catch(() => undefined)
      return
    }
    await unlink(`${path}.${generations}`).catch(() => undefined)
    for (let index = generations - 1; index >= 1; index -= 1) {
      await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => undefined)
    }
    await rename(path, `${path}.1`).catch(() => undefined)
  }

  /**
   * Wait for pending file writes to settle.
   * @returns a promise resolving once the write chain drains.
   */
  async flush(): Promise<void> {
    await this.writeChain
  }

  /**
   * Query retained in-memory records, newest first.
   * @param query - the filter to apply.
   * @returns the matching records.
   */
  query(query: AuditQuery = {}): AuditRecord[] {
    const limit = query.limit ?? 100
    const matches: AuditRecord[] = []
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]
      if (record === undefined) continue
      if (query.sessionId !== undefined && record.sessionId !== query.sessionId) continue
      if (query.toolName !== undefined && record.toolName !== query.toolName) continue
      if (query.verdict !== undefined && record.verdict !== query.verdict) continue
      if (query.since !== undefined && Date.parse(record.timestamp) < query.since) continue
      matches.push(record)
      if (matches.length >= limit) break
    }
    return matches
  }

  /** Number of records retained in memory. */
  get size(): number {
    return this.records.length
  }

  /** Total records recorded since process start, including evicted ones. */
  get total(): number {
    return this.seq
  }
}
