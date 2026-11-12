import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog, defaultAuditPath } from '../../src/audit/audit-log.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentjail-audit-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function options(overrides: Partial<ConstructorParameters<typeof AuditLog>[0]> = {}) {
  return {
    enabled: true,
    storage: 'memory' as const,
    filePath: '',
    maxFileBytes: 0,
    maxRotatedFiles: 0,
    redactSensitiveData: true,
    maxValueChars: 100,
    ...overrides,
  }
}

const base = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  agentId: 'sess-1',
  toolName: 'bash',
  jailToolName: 'Bash',
  cwd: '/tmp',
  verdict: 'deny' as const,
  source: 'engine' as const,
  digest: 'digest-1',
  durationMs: 3,
}

describe('AuditLog', () => {
  it('records a decision with a sequence number and timestamp', async () => {
    const audit = new AuditLog(options())
    const record = await audit.record({ ...base, arguments: { command: 'ls' } })
    expect(record?.seq).toBe(1)
    expect(record?.version).toBe(1)
    expect(record?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record?.verdict).toBe('deny')
  })

  it('increments the sequence for each record', async () => {
    const audit = new AuditLog(options())
    await audit.record({ ...base, arguments: {} })
    const second = await audit.record({ ...base, arguments: {} })
    expect(second?.seq).toBe(2)
    expect(audit.total).toBe(2)
  })

  it('redacts sensitive argument values by default', async () => {
    const audit = new AuditLog(options())
    const record = await audit.record({
      ...base,
      arguments: { command: 'ls', password: 'hunter2' },
    })
    expect(record?.arguments).toEqual({ command: 'ls', password: '<redacted>' })
  })

  it('keeps arguments intact when redaction is disabled', async () => {
    const audit = new AuditLog(options({ redactSensitiveData: false }))
    const record = await audit.record({ ...base, arguments: { password: 'hunter2' } })
    expect(record?.arguments).toEqual({ password: 'hunter2' })
  })

  it('returns undefined when auditing is disabled', async () => {
    const audit = new AuditLog(options({ enabled: false }))
    expect(await audit.record({ ...base, arguments: {} })).toBeUndefined()
  })

  it('returns undefined when the sink is none', async () => {
    const audit = new AuditLog(options({ storage: 'none' }))
    expect(await audit.record({ ...base, arguments: {} })).toBeUndefined()
  })

  it('appends newline-delimited JSON to the file sink', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'audit.jsonl')
    const audit = new AuditLog(options({ storage: 'file', filePath }))
    await audit.record({ ...base, arguments: { command: 'ls' } })
    await audit.record({ ...base, arguments: { command: 'pwd' } })
    await audit.flush()
    const contents = await readFile(filePath, 'utf8')
    const lines = contents.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').seq).toBe(1)
    expect(JSON.parse(lines[1] ?? '{}').seq).toBe(2)
  })

  it('rotates the file past the configured size', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'audit.jsonl')
    const audit = new AuditLog(
      options({ storage: 'file', filePath, maxFileBytes: 400, maxRotatedFiles: 2 }),
    )
    for (let index = 0; index < 12; index += 1) {
      await audit.record({ ...base, arguments: { command: 'x'.repeat(40) } })
    }
    await audit.flush()
    const rotated = await readFile(`${filePath}.1`, 'utf8')
    expect(rotated.length).toBeGreaterThan(0)
    const current = await readFile(filePath, 'utf8')
    expect(current.length).toBeLessThanOrEqual(600)
  })

  it('records a failed append without throwing', async () => {
    // A regular file cannot be a parent directory, so the append fails with
    // ENOTDIR immediately rather than depending on a path that may be writable.
    const blocker = join(await temporaryDirectory(), 'blocker')
    await writeFile(blocker, 'not a directory')
    const audit = new AuditLog(options({ storage: 'file', filePath: join(blocker, 'audit.jsonl') }))
    await audit.record({ ...base, arguments: {} })
    await audit.flush()
    expect(audit.error).toBeDefined()
  })

  it('queries by session, tool, verdict, and time', async () => {
    const audit = new AuditLog(options())
    await audit.record({ ...base, arguments: {}, toolName: 'bash', verdict: 'deny' })
    await audit.record({
      ...base,
      arguments: {},
      toolName: 'read',
      verdict: 'allow',
      sessionId: 'other',
    })
    expect(audit.query({ toolName: 'bash' })).toHaveLength(1)
    expect(audit.query({ verdict: 'allow' })).toHaveLength(1)
    expect(audit.query({ sessionId: 'other' })).toHaveLength(1)
    expect(audit.query({ since: Date.now() + 1000 })).toHaveLength(0)
  })

  it('returns query results newest first and honours the limit', async () => {
    const audit = new AuditLog(options())
    await audit.record({ ...base, arguments: {}, toolName: 'first' })
    await audit.record({ ...base, arguments: {}, toolName: 'second' })
    const results = audit.query({ limit: 1 })
    expect(results).toHaveLength(1)
    expect(results[0]?.toolName).toBe('second')
  })

  it('bounds the in-memory ring', async () => {
    const audit = new AuditLog(options(), 5)
    for (let index = 0; index < 20; index += 1) {
      await audit.record({ ...base, arguments: {}, toolName: `tool-${index}` })
    }
    expect(audit.size).toBe(5)
    expect(audit.total).toBe(20)
  })

  it('resolves a default file path under HOME', () => {
    const audit = new AuditLog(options({ storage: 'file' }))
    expect(audit.filePath).toBe(defaultAuditPath())
    expect(audit.filePath?.endsWith('.agentjail/dsh-audit.jsonl')).toBe(true)
  })

  it('reports no file path when the file sink is off', () => {
    expect(new AuditLog(options()).filePath).toBeUndefined()
  })
})
