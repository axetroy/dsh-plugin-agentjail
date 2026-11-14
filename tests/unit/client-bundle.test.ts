import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

/**
 * The built browser bundle is the artifact the Harness client module system
 * actually loads, and it can fail in ways the source cannot: a lost banner, a
 * dropped export, a second React copy inlined instead of resolved from the page
 * table. These tests evaluate `lib/client.js` in a stand-in module table and
 * assert the registration it produces.
 *
 * The bundle is a build output, so the suite skips when it has not been built
 * (`npm test` before `npm run build`). CI builds and runs
 * `scripts/check-exports.mjs` unconditionally, so the check is never skipped
 * there.
 */
const bundlePath = resolve(process.cwd(), 'lib/client.js')
const built = existsSync(bundlePath)

/** Evaluate the bundle against a stand-in module table and return the result. */
function loadBundle() {
  const require = createRequire(import.meta.url)
  const source = readFileSync(bundlePath, 'utf8')

  /** The page's module table: shared packages come from the host, not the bundle. */
  const load = (specifier: string): unknown => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Tag: (props: { children?: ReactNode }) => createElement('span', null, props.children),
        StateDot: () => createElement('span', null),
        Button: (props: { children?: ReactNode }) => createElement('button', null, props.children),
      }
    }
    throw new Error(`the bundle resolved an unexpected external: ${specifier}`)
  }

  const modules = new Map<string, { apply: (ctx: unknown) => void }>()
  const window = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (r: (s: string) => unknown) => never }) {
        modules.set(entry.id, entry.factory(load))
      },
    },
  }
  runInNewContext(source, { window, require: load, module: {}, exports: {} })

  const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const injected: string[] = []
  const effects: Array<() => void> = []
  const ctx = {
    slots: {
      inject(key: string, callback: () => () => void) {
        injected.push(key)
        return callback()
      },
      register(options: Record<string, unknown>, component: unknown) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(callback: () => () => void) {
      effects.push(callback())
    },
  }

  const id = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).name as string
  const plugin = modules.get(id)
  return { plugin, id, modules, registered, injected, effects, ctx }
}

describe.skipIf(!built)('built client bundle', () => {
  it('registers itself under the package name', () => {
    const { plugin, id } = loadBundle()
    expect(plugin).toBeDefined()
    expect(typeof plugin?.apply).toBe('function')
    expect(id).toBe('dsh-plugin-agentjail')
  })

  it('contributes exactly one settings.section', () => {
    const { ctx, injected, registered, plugin } = loadBundle()
    plugin?.apply(ctx)
    expect(injected).toEqual(['settings.section'])
    expect(registered).toHaveLength(1)
    const entry = registered[0]!
    expect(entry.options['name']).toBe('settings.section')
    expect(entry.options['id']).toBe('agentjail')
    expect(typeof entry.options['order']).toBe('number')
    expect(entry.options['label']).toBe('AgentJail')
  })

  it('hands the section a face that reads the advertised base path', async () => {
    const { ctx, registered, plugin } = loadBundle()
    plugin?.apply(ctx)
    const face = (registered[0]!.options['inject'] as () => { refreshMs: number })()
    expect(typeof face.refreshMs).toBe('number')
  })

  it('resolves React from the page module table rather than inlining it', () => {
    // A second React instance would give the page two slot registries, which is
    // the failure this externals list exists to prevent.
    const source = readFileSync(bundlePath, 'utf8')
    expect(source).toContain('require("react")')
    expect(source).toContain('require("react/jsx-runtime")')
    expect(source).toContain('require("@deepseek-ai/dsh-client-ui-primitives")')
  })
})
