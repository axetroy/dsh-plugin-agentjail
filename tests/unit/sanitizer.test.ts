import { describe, expect, it } from 'vitest'
import {
  REDACTED,
  isSensitiveKey,
  isSensitivePath,
  redactInlineSecrets,
  redactValue,
  truncate,
} from '../../src/security/sanitizer.js'

describe('isSensitivePath', () => {
  it.each([
    '/home/dev/.ssh/id_rsa',
    '/home/dev/.aws/credentials',
    '/home/dev/.gnupg/secring.gpg',
    '/home/dev/.kube/config',
    '/home/dev/project/.env',
    '/home/dev/project/.env.local',
    '/home/dev/.npmrc',
    '/home/dev/.netrc',
    '/certs/server.pem',
    '/certs/server.key',
    '/home/dev/project/credentials.json',
    '/home/dev/project/secrets.yaml',
  ])('flags %s', (path) => {
    expect(isSensitivePath(path)).toBe(true)
  })

  it.each(['/home/dev/project/src/index.ts', '/tmp/build/output.log', '/home/dev/notes.md'])(
    'does not flag %s',
    (path) => {
      expect(isSensitivePath(path)).toBe(false)
    },
  )

  it('does not flag an empty path', () => {
    expect(isSensitivePath('')).toBe(false)
  })
})

describe('isSensitiveKey', () => {
  it.each(['password', 'apiKey', 'api_key', 'access_token', 'private-key', 'authorization'])(
    'flags %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true)
    },
  )

  it.each(['command', 'file_path', 'content', 'url'])('does not flag %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false)
  })
})

describe('redactInlineSecrets', () => {
  it('redacts an inline API key', () => {
    expect(redactInlineSecrets('curl -H "x: sk-abcdefghijklmnopqrstuvwx"')).toContain(REDACTED)
  })

  it('redacts a GitHub token', () => {
    const text = redactInlineSecrets(
      'git clone https://ghp_abcdefghijklmnopqrstuvwx@github.com/x/y',
    )
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwx')
  })

  it('redacts an AWS access key id', () => {
    expect(redactInlineSecrets('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED)
  })

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(redactInlineSecrets(pem)).toBe(REDACTED)
  })

  it('leaves ordinary commands untouched', () => {
    expect(redactInlineSecrets('npm run build --if-present')).toBe('npm run build --if-present')
  })
})

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('marks truncated text', () => {
    const result = truncate('abcdefghij', 4)
    expect(result.startsWith('abcd')).toBe(true)
    expect(result).toContain('truncated 6 chars')
  })

  it('disables truncation at zero', () => {
    expect(truncate('abcdefghij', 0)).toBe('abcdefghij')
  })
})

describe('redactValue', () => {
  it('redacts values under sensitive keys', () => {
    const result = redactValue({ command: 'ls', password: 'hunter2' }, { maxValueChars: 100 })
    expect(result).toEqual({ command: 'ls', password: REDACTED })
  })

  it('redacts sensitive paths wherever they appear', () => {
    const result = redactValue(
      { file_path: '/home/dev/.ssh/id_rsa' },
      { maxValueChars: 100 },
    ) as Record<string, unknown>
    expect(String(result['file_path'])).toContain(REDACTED)
  })

  it('walks nested objects and arrays', () => {
    const result = redactValue(
      { nested: { deeper: { token: 'abc' } }, list: [{ apiKey: 'x' }] },
      { maxValueChars: 100 },
    )
    expect(result).toEqual({
      nested: { deeper: { token: REDACTED } },
      list: [{ apiKey: REDACTED }],
    })
  })

  it('preserves non-string scalars', () => {
    const result = redactValue({ n: 1, b: true, nil: null }, { maxValueChars: 10 })
    expect(result).toEqual({ n: 1, b: true, nil: null })
  })

  it('bounds traversal depth', () => {
    let deep: Record<string, unknown> = { value: 'leaf' }
    for (let index = 0; index < 20; index += 1) deep = { child: deep }
    const result = redactValue(deep, { maxValueChars: 10, maxDepth: 3 })
    expect(JSON.stringify(result)).toContain('depth-limit')
  })

  it('bounds array length', () => {
    const result = redactValue(
      { list: Array.from({ length: 100 }, (_, index) => index) },
      { maxValueChars: 10, maxItems: 5 },
    ) as Record<string, unknown>
    expect((result['list'] as unknown[]).length).toBe(6)
  })

  it('truncates long leaf strings', () => {
    const result = redactValue({ command: 'x'.repeat(500) }, { maxValueChars: 10 })
    expect(String((result as Record<string, unknown>)['command'])).toContain('truncated')
  })
})
