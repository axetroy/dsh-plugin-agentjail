/**
 * The AgentJail settings section.
 *
 * A read-only view of the plugin's audit trail, risk statistics, engine health,
 * and outstanding approvals, rendered inside the Harness Settings panel through
 * the slot system rather than on a page the plugin serves itself. Nothing here
 * can widen a policy, clear a denial, or change the failure posture.
 *
 * Transport stays in the registrant's inject face: this component only calls
 * the callbacks it is handed and renders their results.
 * @module dsh-plugin-agentjail/client/AgentJailSection
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Button, StateDot, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelData, PanelFace } from './face.js'
import {
  decisionLabel,
  formatDuration,
  formatRate,
  formatTimestamp,
  healthDot,
  verdictTone,
} from './format.js'

/** Composed props: the settings owner's share plus the registrant's face. */
export interface AgentJailSectionProps extends PanelFace {
  /** Close the settings panel; owned by the settings shell. */
  close: () => void
}

/** Map a verdict tone name onto a Tag tone. */
function tagTone(tone: 'ok' | 'warn' | 'bad' | 'muted'): TagTone {
  if (tone === 'ok') return 'success'
  if (tone === 'warn') return 'warning'
  if (tone === 'bad') return 'danger'
  return 'neutral'
}

/** One labelled figure. */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        minWidth: '7rem',
        padding: '0.5rem 0.75rem',
        border: '1px solid var(--dsh-border, #ddd)',
        borderRadius: '6px',
      }}
    >
      <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: '1rem', fontWeight: 600 }}>{value}</div>
    </div>
  )
}

/**
 * Render the AgentJail settings section.
 * @param props - the settings owner's `close` plus the registrant's face.
 * @returns the section content.
 */
export function AgentJailSection({ load, refreshMs }: AgentJailSectionProps): JSX.Element {
  const [data, setData] = useState<PanelData | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setData(await load())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while the section is mounted so a long-running session keeps showing
  // new decisions without the operator refreshing by hand.
  useEffect(() => {
    if (!Number.isFinite(refreshMs) || refreshMs <= 0) return
    const timer = setInterval(() => void refresh(), refreshMs)
    return () => clearInterval(timer)
  }, [refresh, refreshMs])

  const summary = data?.summary
  const stats = summary?.stats
  const records = useMemo(() => data?.records ?? [], [data])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>AgentJail</h2>
        {summary === undefined ? null : (
          <>
            <Tag tone={summary.enforcement === 'enforce' ? 'success' : 'info'}>
              {summary.enforcement}
            </Tag>
            <Tag tone={summary.failureAction === 'deny' ? 'danger' : 'warning'}>
              fail: {summary.failureAction}
            </Tag>
            <Tag tone="neutral">default: {summary.defaultAction}</Tag>
          </>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>

      {error === undefined ? null : (
        <div role="alert" style={{ color: 'var(--dsh-danger, #c00)' }}>
          Could not read the AgentJail audit trail: {error}
        </div>
      )}

      {data === undefined || summary === undefined ? (
        <div style={{ opacity: 0.7 }}>Loading…</div>
      ) : (
        <>
          <section style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <StateDot state={healthDot(summary.health.state)} />
            <span>policy engine: {summary.health.state}</span>
            <span style={{ opacity: 0.7 }}>· supervision: {summary.supervision.state}</span>
            <span style={{ opacity: 0.7 }}>· {summary.health.socketPath}</span>
          </section>

          {summary.health.lastError === undefined || summary.health.lastError === null ? null : (
            <div style={{ opacity: 0.8 }}>last error: {summary.health.lastError}</div>
          )}

          <section style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <Tile label="decisions" value={String(stats?.total ?? 0)} />
            <Tile label="allow" value={String(stats?.allow ?? 0)} />
            <Tile label="deny" value={String(stats?.deny ?? 0)} />
            <Tile label="ask" value={String(stats?.ask ?? 0)} />
            <Tile label="deny rate" value={formatRate(stats?.denyRate ?? Number.NaN)} />
            <Tile label="offload rate" value={formatRate(stats?.offloadRate ?? Number.NaN)} />
            <Tile
              label="mean latency"
              value={formatDuration(stats?.meanDurationMs ?? Number.NaN)}
            />
          </section>

          {summary.alerts.length === 0 ? null : (
            <section>
              <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.875rem' }}>alerts</h3>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {summary.alerts.slice(-10).map((alert, index) => (
                  <li key={`${alert.kind}-${index}`}>
                    <Tag tone="warning">{alert.kind}</Tag> {alert.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.875rem' }}>recent decisions</h3>
            {records.length === 0 ? (
              <div style={{ opacity: 0.7 }}>(none)</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                    <th scope="col">time</th>
                    <th scope="col">tool</th>
                    <th scope="col">verdict</th>
                    <th scope="col">rule</th>
                    <th scope="col">reason</th>
                  </tr>
                </thead>
                <tbody>
                  {records.slice(0, 50).map((row) => (
                    <tr key={row.seq}>
                      <td>{row.timestamp}</td>
                      <td>{row.toolName}</td>
                      <td>
                        <Tag tone={tagTone(verdictTone(row.verdict))}>{row.verdict}</Tag>
                      </td>
                      <td>{decisionLabel(row)}</td>
                      <td style={{ opacity: 0.8 }}>{row.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.875rem' }}>outstanding approvals</h3>
            {summary.grants.length === 0 ? (
              <div style={{ opacity: 0.7 }}>(none)</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {summary.grants.map((grant) => (
                  <li key={grant.id}>
                    {grant.toolName} · {grant.scope} · session {grant.sessionId} · expires{' '}
                    {formatTimestamp(grant.expiresAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
