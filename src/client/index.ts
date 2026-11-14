/**
 * Browser half of the AgentJail plugin.
 *
 * The client module system discovers this entry through the package's
 * `dsh.client` declaration and serves the bundle built from it. It registers
 * one settings section, so the audit trail, risk statistics, engine health, and
 * outstanding approvals appear inside the Harness Settings panel instead of on
 * a page the plugin serves itself.
 *
 * Cross-plugin collaboration goes through the slot service only: this module
 * never imports another feature plugin's runtime values, and it is handed the
 * `settings.section` owner props by the settings shell.
 *
 * Transport is the plugin's own read-only JSON route, which the Host registers
 * next to the enforcement path. The Host advertises that route's base path as a
 * global injection row, so a deployment that moves `ui.basePath` still reaches
 * the right endpoint.
 * @module dsh-plugin-agentjail/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AgentJailSection } from './AgentJailSection.js'
import { registerAgentJailSection } from './face.js'

export type { AgentJailSectionProps } from './AgentJailSection.js'
export type { PanelData, PanelFace } from './face.js'
export type { DashboardSummary, DecisionRow } from './format.js'
export { SECTION_ID } from './face.js'

/** Services required by the settings registration. */
export const inject = ['slots']

/**
 * Register the AgentJail settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  registerAgentJailSection(ctx, AgentJailSection)
}
