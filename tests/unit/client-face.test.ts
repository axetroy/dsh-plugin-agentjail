import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  DEFAULT_BASE_PATH,
  DEFAULT_REFRESH_MS,
  advertisedRefreshMs,
  basePath,
  createFace,
  registerAgentJailSection,
  SECTION_ID,
} from '../../src/client/face.js'

/** Replace `globalThis.__AGENTJAIL_UI__`, which the Host injects. */
function advertise(value: unknown): void {
  ;(globalThis as { __AGENTJAIL_UI__?: unknown }).__AGENTJAIL_UI__ = value
}

afterEach(() => {
  delete (globalThis as { __AGENTJAIL_UI__?: unknown }).__AGENTJAIL_UI__
  vi.unstubAllGlobals()
})

describe('advertised UI globals', () => {
  it('falls back to the shipped base path when nothing is injected', () => {
    expect(basePath()).toBe(DEFAULT_BASE_PATH)
  })

  it('falls back when the injected row is empty or malformed', () => {
    advertise({})
    expect(basePath()).toBe(DEFAULT_BASE_PATH)
    advertise({ basePath: '' })
    expect(basePath()).toBe(DEFAULT_BASE_PATH)
    advertise({ basePath: 42 })
    expect(basePath()).toBe(DEFAULT_BASE_PATH)
    advertise('not an object')
    expect(basePath()).toBe(DEFAULT_BASE_PATH)
  })

  it('uses the injected base path when one is present', () => {
    advertise({ basePath: '/security/agentjail' })
    expect(basePath()).toBe('/security/agentjail')
  })

  it('falls back to the default interval when nothing usable is injected', () => {
    expect(advertisedRefreshMs()).toBe(DEFAULT_REFRESH_MS)
    advertise({ refreshMs: -1 })
    expect(advertisedRefreshMs()).toBe(DEFAULT_REFRESH_MS)
    advertise({ refreshMs: Number.NaN })
    expect(advertisedRefreshMs()).toBe(DEFAULT_REFRESH_MS)
    advertise({ refreshMs: 'soon' })
    expect(advertisedRefreshMs()).toBe(DEFAULT_REFRESH_MS)
  })

  it('honours a configured interval, including zero', () => {
    advertise({ refreshMs: 2500 })
    expect(advertisedRefreshMs()).toBe(2500)
    advertise({ refreshMs: 0 })
    expect(advertisedRefreshMs()).toBe(0)
  })
})

describe('inject face', () => {
  it('reads the summary and the decisions from the advertised base path', async () => {
    advertise({ basePath: '/security/agentjail', refreshMs: 0 })
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      expect(init).toEqual({ headers: { accept: 'application/json' } })
      if (url.endsWith('/api/summary')) {
        return { ok: true, json: async () => ({ enforcement: 'enforce' }) }
      }
      return { ok: true, json: async () => ({ count: 1, records: [{ seq: 7 }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const face = createFace()
    expect(face.refreshMs).toBe(0)
    const data = await face.load()

    expect(calls.sort()).toEqual([
      '/security/agentjail/api/decisions',
      '/security/agentjail/api/summary',
    ])
    expect(data.summary).toEqual({ enforcement: 'enforce' })
    expect(data.records).toEqual([{ seq: 7 }])
  })

  it('refuses a non-2xx answer instead of rendering a partial panel', async () => {
    advertise({ basePath: '/agentjail' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    )
    await expect(createFace().load()).rejects.toThrow('/agentjail/api/summary answered 500')
  })
})

describe('settings section registration', () => {
  /** A minimal stand-in for the slot service the registration talks to. */
  function fakeSlots() {
    const injected: string[] = []
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const disposers: Array<() => void> = []
    return {
      injected,
      registered,
      service: {
        inject(key: string, callback: () => () => void) {
          injected.push(key)
          disposers.push(callback())
          return () => {}
        },
        register(options: Record<string, unknown>, component: unknown) {
          registered.push({ options, component })
          return () => {}
        },
      },
      disposeAll() {
        for (const dispose of disposers) dispose()
      },
    }
  }

  /** A context carrying only what the registration uses. */
  function fakeContext(slots: unknown) {
    const effects: Array<() => void> = []
    const context = {
      slots,
      effect(callback: () => () => void) {
        effects.push(callback())
        return () => {}
      },
    } as unknown as ClientContext
    return { context, effects }
  }

  it('injects into settings.section and registers the section once', () => {
    advertise({ basePath: '/agentjail', refreshMs: 0 })
    const slots = fakeSlots()
    const { context, effects } = fakeContext(slots.service)
    const component = () => null

    registerAgentJailSection(context, component)

    expect(effects).toHaveLength(1)
    expect(slots.injected).toEqual(['settings.section'])
    expect(slots.registered).toHaveLength(1)
    const entry = slots.registered[0]!
    expect(entry.component).toBe(component)
    expect(entry.options['name']).toBe('settings.section')
    expect(entry.options['id']).toBe(SECTION_ID)
    expect(typeof entry.options['label']).toBe('string')

    // The inject factory hands the component the face the section reads through.
    const face = (entry.options['inject'] as () => { refreshMs: number })()
    expect(face.refreshMs).toBe(0)
    slots.disposeAll()
  })
})
