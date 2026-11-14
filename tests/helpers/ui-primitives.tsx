/**
 * Stand-in for `@deepseek-ai/dsh-client-ui-primitives` inside Vitest.
 *
 * The real package ships CSS modules, workspace-path helpers, and other assets
 * that only load inside the Harness module table, so importing it under Node
 * fails before a single test runs. These render the same DOM shape the section
 * depends on — a tag, a status dot, a button — while the component, the inject
 * face, and the transport under test all stay real code.
 *
 * The alias lives in `vitest.config.ts`; `tsc` still type-checks against the
 * published declarations, so a change to the real props fails the build.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Palette selector, mirroring the published union. */
export type TagTone =
  'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

/** Render a tag as a span carrying its tone. */
export function Tag({ tone = 'outline', children }: { tone?: TagTone; children?: ReactNode }) {
  return <span data-tone={tone}>{children}</span>
}

/** Status-dot state, mirroring the published union. */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** Render a status dot as an aria-hidden span carrying its state. */
export function StateDot({ state }: { state: StateDotState }) {
  return <span aria-hidden="true" data-state={state} />
}

/** Render a native button. */
export function Button({
  children,
  ...rest
}: {
  variant?: string
  size?: 'md' | 'sm'
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest}>{children}</button>
}
