import { describe, expect, it } from 'vitest'
import { GrantStore } from '../../src/security/grants.js'

function store(overrides: Partial<{ maxGrants: number; sessionGrantTtlMs: number }> = {}) {
  return new GrantStore({ maxGrants: 10, sessionGrantTtlMs: 1000, ...overrides })
}

describe('GrantStore', () => {
  it('issues and consumes a one-time grant exactly once', () => {
    const grants = store()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 's', digest: 'd1' })
    expect(grants.consume({ toolName: 'bash', sessionId: 's', digest: 'd1' }).kind).toBe('granted')
    expect(grants.consume({ toolName: 'bash', sessionId: 's', digest: 'd1' }).kind).toBe('missing')
  })

  it('keeps a session grant reusable until it expires', () => {
    const grants = store()
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1', now: 1000 })
    expect(grants.consume({ toolName: 'bash', sessionId: 's', digest: 'd1', now: 1100 }).kind).toBe(
      'granted',
    )
    expect(grants.consume({ toolName: 'bash', sessionId: 's', digest: 'd1', now: 1200 }).kind).toBe(
      'granted',
    )
  })

  it('expires a session grant past its TTL', () => {
    const grants = store({ sessionGrantTtlMs: 500 })
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1', now: 1000 })
    expect(grants.consume({ toolName: 'bash', sessionId: 's', digest: 'd1', now: 1600 }).kind).toBe(
      'missing',
    )
  })

  it('binds a grant to the argument digest', () => {
    const grants = store()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 's', digest: 'approved-digest' })
    expect(
      grants.consume({ toolName: 'bash', sessionId: 's', digest: 'different-digest' }).kind,
    ).toBe('missing')
  })

  it('binds a grant to the session', () => {
    const grants = store()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 'session-a', digest: 'd1' })
    expect(grants.consume({ toolName: 'bash', sessionId: 'session-b', digest: 'd1' }).kind).toBe(
      'missing',
    )
  })

  it('binds a grant to the tool', () => {
    const grants = store()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 's', digest: 'd1' })
    expect(grants.consume({ toolName: 'write', sessionId: 's', digest: 'd1' }).kind).toBe('missing')
  })

  it('reports existence without consuming', () => {
    const grants = store()
    grants.issue({ scope: 'once', toolName: 'bash', sessionId: 's', digest: 'd1' })
    expect(grants.has({ toolName: 'bash', sessionId: 's', digest: 'd1' })).toBe(true)
    expect(grants.has({ toolName: 'bash', sessionId: 's', digest: 'd1' })).toBe(true)
  })

  it('revokes by id', () => {
    const grants = store()
    const grant = grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1' })
    expect(grants.revoke(grant.id)).toBe(true)
    expect(grants.has({ toolName: 'bash', sessionId: 's', digest: 'd1' })).toBe(false)
    expect(grants.revoke(grant.id)).toBe(false)
  })

  it('revokes every grant in a session', () => {
    const grants = store()
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1' })
    grants.issue({ scope: 'session', toolName: 'write', sessionId: 's', digest: 'd2' })
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 'other', digest: 'd3' })
    expect(grants.revokeSession('s')).toBe(2)
    expect(grants.size).toBe(1)
  })

  it('evicts the oldest grant past the cap', () => {
    const grants = store({ maxGrants: 2 })
    grants.issue({ scope: 'session', toolName: 'a', sessionId: 's', digest: 'd1' })
    grants.issue({ scope: 'session', toolName: 'b', sessionId: 's', digest: 'd2' })
    grants.issue({ scope: 'session', toolName: 'c', sessionId: 's', digest: 'd3' })
    expect(grants.size).toBe(2)
    expect(grants.has({ toolName: 'a', sessionId: 's', digest: 'd1' })).toBe(false)
    expect(grants.has({ toolName: 'c', sessionId: 's', digest: 'd3' })).toBe(true)
  })

  it('replaces a grant for the same identity rather than duplicating it', () => {
    const grants = store()
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1' })
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1' })
    expect(grants.size).toBe(1)
  })

  it('lists live grants and drops expired ones', () => {
    const grants = store({ sessionGrantTtlMs: 100 })
    grants.issue({ scope: 'session', toolName: 'bash', sessionId: 's', digest: 'd1', now: 1000 })
    grants.issue({ scope: 'once', toolName: 'write', sessionId: 's', digest: 'd2', now: 1000 })
    const live = grants.list(1050)
    expect(live).toHaveLength(2)
    expect(grants.list(1200)).toHaveLength(1)
  })

  it('assigns distinct ids to distinct grants', () => {
    const grants = store()
    const first = grants.issue({ scope: 'session', toolName: 'a', sessionId: 's', digest: 'd1' })
    const second = grants.issue({ scope: 'session', toolName: 'b', sessionId: 's', digest: 'd2' })
    expect(first.id).not.toBe(second.id)
  })

  it('clears every grant', () => {
    const grants = store()
    grants.issue({ scope: 'session', toolName: 'a', sessionId: 's', digest: 'd1' })
    grants.clear()
    expect(grants.size).toBe(0)
  })
})
