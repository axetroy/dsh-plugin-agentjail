import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const english = readFileSync(resolve(root, 'README.md'), 'utf8')
const chinese = readFileSync(resolve(root, 'README.zh-CN.md'), 'utf8')

/** Top-level sections, excluding headings inside fenced code blocks. */
function sections(markdown: string): string[] {
  const withoutFences = markdown.replace(/^```[\s\S]*?^```/gm, '')
  return withoutFences.match(/^## .+$/gm) ?? []
}

/** Fenced block languages, so a translated example cannot drop a snippet. */
function fences(markdown: string): string[] {
  return [...markdown.matchAll(/^```(\w*)/gm)].map((match) => match[1] ?? '')
}

describe('localized READMEs', () => {
  it('link to each other so either entry point can switch language', () => {
    expect(english).toContain('./README.zh-CN.md')
    expect(chinese).toContain('./README.md')
  })

  it('mark the current language rather than the other one', () => {
    expect(english).toContain('**English** | [简体中文](./README.zh-CN.md)')
    expect(chinese).toContain('[English](./README.md) | **简体中文**')
  })

  it('cover the same sections, so a translation cannot silently fall behind', () => {
    const en = sections(english)
    const zh = sections(chinese)
    expect(zh.length).toBe(en.length)
  })

  it('carry the same code samples', () => {
    expect(fences(chinese)).toEqual(fences(english))
  })

  it('share the same install and API surface', () => {
    for (const token of [
      'dsh plugin --profile secure add dsh-plugin-agentjail',
      'agentjail daemon',
      'ctx.agentjail.queryAudit',
      'ctx.agentjail.revokeSession',
      'npm run verify',
      'Apache-2.0',
    ]) {
      expect(english).toContain(token)
      expect(chinese).toContain(token)
    }
  })

  it('document the same default verdicts in both languages', () => {
    for (const token of ['failureAction: deny', 'defaultAction: deny', 'enforcement: enforce']) {
      expect(english).toContain(token)
      expect(chinese).toContain(token)
    }
  })

  it('link to every document that exists in the repository', () => {
    for (const target of ['CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'docs/THREAT-MODEL.md']) {
      expect(chinese).toContain(target)
    }
  })

  it('link the new operational documents from both languages', () => {
    for (const target of ['docs/INSTALL.md', 'docs/UI.md']) {
      expect(english).toContain(target)
      expect(chinese).toContain(target)
    }
  })

  it('document the dashboard surface in both languages', () => {
    for (const token of [
      '/agentjail/api/summary',
      '/agentjail/api/decisions',
      '/agentjail/api/health',
      'daemon.managedInstall',
      'daemon.supervise',
    ]) {
      expect(english).toContain(token)
      expect(chinese).toContain(token)
    }
  })

  it('document the same service accessors in both languages', () => {
    for (const token of [
      'ctx.agentjail.dashboard()',
      'ctx.agentjail.dashboardText()',
      'ctx.agentjail.supervision()',
      'ctx.agentjail.ensureDaemon()',
    ]) {
      expect(english).toContain(token)
      expect(chinese).toContain(token)
    }
  })

  it('does not claim a Node floor below the one package.json declares', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      engines: Record<string, string>
    }
    const floor = (manifest.engines['node'] ?? '').replace(/^[^\d]*/, '')
    expect(english).toContain(`Node.js \`>=${floor}\``)
    expect(chinese).toContain(`Node.js \`>=${floor}\``)
  })

  it('states the supported platforms in both languages', () => {
    expect(english).toContain('**Windows is not supported.**')
    expect(chinese).toContain('**不支持 Windows。**')
  })
})
