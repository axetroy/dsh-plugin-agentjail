/**
 * Data face and slot registration for the AgentJail settings section.
 *
 * Kept apart from the component so the transport and the registration can be
 * exercised without a DOM: everything here runs on plain `fetch` and the slot
 * service, and the component arrives as an argument.
 * @module dsh-plugin-agentjail/client/face
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.slots` service merge and the `SlotMap` declaration
// point into this program. Cross-plugin collaboration never imports a value.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentJailSectionProps } from './AgentJailSection.js'
import { dataUrl, type DashboardSummary, type DecisionRow } from './format.js'

/** The section key shared by the navigation row and the panel body. */
export const SECTION_ID = 'agentjail'

/** Default base path, matching the plugin's shipped configuration. */
export const DEFAULT_BASE_PATH = '/agentjail'

/** Default poll interval, matching the plugin's shipped configuration. */
export const DEFAULT_REFRESH_MS = 5000

/** What one refresh reads from the plugin's data routes. */
export interface PanelData {
  summary: DashboardSummary
  records: DecisionRow[]
}

/** The inject face the registrant hands the section component. */
export interface PanelFace {
  /** Poll interval in milliseconds; `0` disables it. */
  refreshMs: number
  /**
   * Read the current summary and recent decisions.
   *
   * Declared as a property rather than a method so it can be passed around
   * without an unbound `this`.
   * @returns the two documents the panel renders.
   */
  load: () => Promise<PanelData>
}

/** The global row the Host injects so a moved base path still resolves. */
interface AdvertisedUi {
  basePath?: unknown
  refreshMs?: unknown
}

/** Read the UI row the Host contributed at index render time. */
function advertised(): AdvertisedUi | undefined {
  return (globalThis as { __AGENTJAIL_UI__?: AdvertisedUi }).__AGENTJAIL_UI__
}

/**
 * Read the base path the Host advertised for the plugin's data route.
 *
 * The Host contributes a `global` index-injection row on every index render, so
 * a deployment that moves `ui.basePath` still reaches the endpoint.
 * @returns the configured base path.
 */
export function basePath(): string {
  const value = advertised()?.basePath
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_BASE_PATH
}

/**
 * Read the poll interval the Host advertised.
 * @returns the interval in milliseconds, or the default when it is absent.
 */
export function advertisedRefreshMs(): number {
  const value = advertised()?.refreshMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_REFRESH_MS
}

/** Read and parse one JSON document, refusing a non-2xx answer. */
async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`)
  }
  return (await response.json()) as T
}

/**
 * Build the registrant's face over the plugin's read-only data routes.
 * @returns the face handed to the section component through `inject`.
 */
export function createFace(): PanelFace {
  return {
    refreshMs: advertisedRefreshMs(),
    async load(): Promise<PanelData> {
      const base = basePath()
      const [summary, decisions] = await Promise.all([
        readJson<DashboardSummary>(dataUrl(base, '/api/summary')),
        readJson<{ records: DecisionRow[] }>(dataUrl(base, '/api/decisions')),
      ])
      return { summary, records: decisions.records }
    },
  }
}

/**
 * Register the AgentJail section into the Harness Settings panel.
 *
 * `inject` waits for the settings domain to declare `settings.section`, so the
 * registration survives any load order. The disposer the slot service returns is
 * registered as an effect, so unloading the plugin removes the section.
 * @param ctx - the browser plugin context.
 * @param component - the section component.
 */
export function registerAgentJailSection(
  ctx: ClientContext,
  component: SlotComponent<AgentJailSectionProps>,
): void {
  const face = createFace()
  ctx.effect(() =>
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: 100,
          label: 'AgentJail',
          inject: () => face,
        },
        component,
      ),
    ),
  )
}
