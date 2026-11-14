// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AgentJailSection } from '../../src/client/AgentJailSection.js'
import type { PanelData } from '../../src/client/face.js'

function panel(overrides: Partial<PanelData> = {}): PanelData {
  return {
    summary: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      enforcement: 'enforce',
      failureAction: 'deny',
      defaultAction: 'deny',
      supervision: { state: 'external', managed: false },
      health: { state: 'healthy', socketPath: '/tmp/x.sock' },
      stats: {
        total: 4,
        allow: 2,
        deny: 1,
        ask: 1,
        denyRate: 0.25,
        askRate: 0.25,
        offloadRate: 0,
        meanDurationMs: 3,
      },
      grants: [],
      alerts: [],
    },
    records: [],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

describe('AgentJail settings section', () => {
  it('renders the summary after the first load', async () => {
    const load = vi.fn().mockResolvedValue(panel())
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(await screen.findByText('policy engine: healthy')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('renders the decision table and the approval list', async () => {
    const load = vi.fn().mockResolvedValue(
      panel({
        summary: {
          ...panel().summary,
          grants: [
            {
              id: 'g1',
              sessionId: 's1',
              toolName: 'Write',
              expiresAt: 1_800_000_000_000,
              scope: 'session',
            },
          ],
        },
        records: [
          {
            seq: 1,
            timestamp: '2026-01-01T00:00:00.000Z',
            toolName: 'Bash',
            verdict: 'deny',
            source: 'engine',
            ruleId: 'no-rm-rf',
            reason: 'destructive command',
          },
        ],
      }),
    )
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(await screen.findByText('no-rm-rf')).toBeTruthy()
    expect(screen.getByText(/session s1/)).toBeTruthy()
    // The verdict appears in the row's tag; the header tags also say "deny".
    expect(screen.getAllByText('deny').length).toBeGreaterThan(0)
  })

  it('shows the error the face threw instead of crashing', async () => {
    const load = vi.fn().mockRejectedValue(new Error('/agentjail/api/summary answered 500'))
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('answered 500')
  })

  it('stringifies a thrown non-Error', async () => {
    const load = vi.fn().mockRejectedValue('plain failure')
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('plain failure')
  })

  it('polls on the advertised interval and stops when unmounted', async () => {
    vi.useFakeTimers()
    try {
      const load = vi.fn().mockResolvedValue(panel())
      const { unmount } = render(<AgentJailSection load={load} refreshMs={1000} close={() => {}} />)
      await vi.advanceTimersByTimeAsync(0)
      expect(load).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(load).toHaveBeenCalledTimes(2)
      unmount()
      await vi.advanceTimersByTimeAsync(5000)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when the interval is zero or not finite', async () => {
    vi.useFakeTimers()
    try {
      const zero = vi.fn().mockResolvedValue(panel())
      const first = render(<AgentJailSection load={zero} refreshMs={0} close={() => {}} />)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(zero).toHaveBeenCalledTimes(1)
      first.unmount()

      const infinite = vi.fn().mockResolvedValue(panel())
      const second = render(
        <AgentJailSection load={infinite} refreshMs={Number.POSITIVE_INFINITY} close={() => {}} />,
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(infinite).toHaveBeenCalledTimes(1)
      second.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes on demand', async () => {
    const load = vi.fn().mockResolvedValue(panel())
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    screen.getByRole('button').click()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('renders the alerts, the empty states, and the last error', async () => {
    const load = vi.fn().mockResolvedValue(
      panel({
        summary: {
          ...panel().summary,
          health: { state: 'degraded', socketPath: '/tmp/x.sock', lastError: 'dial tcp refused' },
          alerts: [
            { kind: 'denied', toolName: 'Bash', message: 'blocked rm -rf' },
            { kind: 'asked', toolName: 'Write', message: 'needs approval' },
          ],
        },
      }),
    )
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(await screen.findByText('blocked rm -rf')).toBeTruthy()
    expect(screen.getByText('needs approval')).toBeTruthy()
    expect(screen.getByText(/last error: dial tcp refused/)).toBeTruthy()
    // No records and no grants: both sections show their empty state.
    expect(screen.getAllByText('(none)')).toHaveLength(2)
  })

  it('renders every verdict tone, including an unrecognized one', async () => {
    const rows = ['deny', 'ask', 'allow', 'deferred'].map((verdict, index) => ({
      seq: index,
      timestamp: '2026-01-01T00:00:00.000Z',
      toolName: 'Bash',
      verdict,
      source: 'engine',
      ruleId: null,
      reason: null,
    }))
    const load = vi.fn().mockResolvedValue(panel({ records: rows }))
    const { container } = render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(await screen.findByText('deferred')).toBeTruthy()
    const tagged = Array.from(container.querySelectorAll<HTMLElement>('[data-tone]'))
    const tones = tagged.map((node) => node.dataset['tone'])
    expect(tones).toContain('danger')
    expect(tones).toContain('warning')
    expect(tones).toContain('success')
    expect(tones).toContain('neutral')
  })

  it('shows an em dash for a rate the engine could not compute', async () => {
    const load = vi.fn().mockResolvedValue(
      panel({
        summary: {
          ...panel().summary,
          stats: { ...panel().summary.stats, denyRate: Number.NaN, meanDurationMs: Number.NaN },
        },
      }),
    )
    const { container } = render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    await screen.findByText('policy engine: healthy')
    expect(container.textContent).toContain('—')
  })

  it('shows the loading state before the first answer arrives', () => {
    const load = vi.fn(() => new Promise<PanelData>(() => {}))
    render(<AgentJailSection load={load} refreshMs={0} close={() => {}} />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })
})
