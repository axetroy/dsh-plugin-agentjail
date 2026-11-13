import { describe, expect, it } from 'vitest'
import {
  HOOK_EVENT,
  JAIL_TOOL,
  isMcpToolName,
  normalizeToolCall,
  parseMcpToolName,
} from '../../src/security/normalizer.js'

const base = { sessionId: 'sess-1', cwd: '/home/dev/project' }

describe('normalizeToolCall', () => {
  it('translates bash into the AgentJail Bash vocabulary', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'bash',
      arguments: { command: 'rm -rf /tmp/x', timeoutMs: 5000, workdir: '/tmp' },
    })
    expect(request.toolName).toBe(JAIL_TOOL.BASH)
    expect(request.hookEvent).toBe(HOOK_EVENT.PRE_TOOL_USE)
    expect(request.toolInput).toEqual({
      command: 'rm -rf /tmp/x',
      cwd: '/tmp',
      timeout: 5000,
    })
  })

  it('translates read into file_path', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'read',
      arguments: { file_path: '/etc/passwd', offset: 1, limit: 10 },
    })
    expect(request.toolName).toBe(JAIL_TOOL.READ)
    expect(request.toolInput).toEqual({ file_path: '/etc/passwd', offset: 1, limit: 10 })
  })

  it('translates write into file_path and content', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'write',
      arguments: { file_path: '/tmp/a.txt', content: 'hello' },
    })
    expect(request.toolName).toBe(JAIL_TOOL.WRITE)
    expect(request.toolInput).toEqual({ file_path: '/tmp/a.txt', content: 'hello' })
  })

  it('translates edit into the Claude Code edit vocabulary', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'edit',
      arguments: { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
    })
    expect(request.toolName).toBe(JAIL_TOOL.EDIT)
    expect(request.toolInput).toEqual({ file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' })
  })

  it('preserves MCP server-qualified names verbatim', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'mcp__filesystem__read_file',
      arguments: { path: '/tmp/a' },
    })
    expect(request.toolName).toBe('mcp__filesystem__read_file')
    expect(request.mcpServer).toBe('filesystem')
    expect(request.mcpTool).toBe('read_file')
    expect(request.toolInput).toEqual({ path: '/tmp/a' })
  })

  it('preserves unknown tools instead of silently exempting them', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'some_future_tool',
      arguments: { alpha: 1 },
    })
    expect(request.toolName).toBe(JAIL_TOOL.OTHER)
    expect(request.toolInput).toEqual({ raw_tool_name: 'some_future_tool', alpha: 1 })
    expect(request.harnessToolName).toBe('some_future_tool')
  })

  it('records the original harness tool name for audit', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'bash',
      arguments: { command: 'ls' },
    })
    expect(request.harnessToolName).toBe('bash')
    expect(request.sessionId).toBe('sess-1')
    expect(request.cwd).toBe('/home/dev/project')
  })

  it('does not mutate the caller arguments', () => {
    const arguments_ = { command: 'ls', workdir: '/tmp' }
    normalizeToolCall({ ...base, toolName: 'bash', arguments: arguments_ })
    expect(arguments_).toEqual({ command: 'ls', workdir: '/tmp' })
  })

  it('tolerates a bash call with no command', () => {
    const request = normalizeToolCall({ ...base, toolName: 'bash', arguments: {} })
    expect(request.toolName).toBe(JAIL_TOOL.BASH)
    expect(request.toolInput['command']).toBe('')
  })

  it('maps web_fetch and web_search', () => {
    expect(
      normalizeToolCall({ ...base, toolName: 'web_fetch', arguments: { url: 'https://x.dev' } })
        .toolName,
    ).toBe(JAIL_TOOL.WEB_FETCH)
    expect(
      normalizeToolCall({ ...base, toolName: 'web_search', arguments: { query: 'x' } }).toolName,
    ).toBe(JAIL_TOOL.WEB_SEARCH)
  })

  it('maps skill and apply_patch', () => {
    expect(
      normalizeToolCall({ ...base, toolName: 'skill', arguments: { name: 'x' } }).toolName,
    ).toBe(JAIL_TOOL.SKILL)
    const patch = normalizeToolCall({
      ...base,
      toolName: 'apply_patch',
      arguments: { patch: '*** Begin Patch' },
    })
    expect(patch.toolName).toBe(JAIL_TOOL.EDIT)
    expect(patch.toolInput['patch']).toBe('*** Begin Patch')
  })
})

describe('parseMcpToolName', () => {
  it('splits a server-qualified name', () => {
    expect(parseMcpToolName('mcp__git__status')).toEqual({ server: 'git', tool: 'status' })
  })

  it('keeps underscores inside the tool name', () => {
    expect(parseMcpToolName('mcp__filesystem__read_file')).toEqual({
      server: 'filesystem',
      tool: 'read_file',
    })
  })

  it('rejects a bare mcp prefix', () => {
    expect(parseMcpToolName('mcp__')).toBeUndefined()
    expect(parseMcpToolName('mcp__server__')).toBeUndefined()
  })

  it('rejects ordinary tool names', () => {
    expect(parseMcpToolName('bash')).toBeUndefined()
    expect(isMcpToolName('bash')).toBe(false)
    expect(isMcpToolName('mcp__git__status')).toBe(true)
  })
})

describe('normalizeToolCall optional fields', () => {
  it('carries a bash justification through when present', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'bash',
      arguments: { command: 'ls', justification: 'list the directory' },
    })
    expect(request.toolInput['justification']).toBe('list the directory')
  })

  it('accepts alternate path key spellings for file tools', () => {
    for (const key of ['path', 'filePath']) {
      expect(
        normalizeToolCall({ ...base, toolName: 'read', arguments: { [key]: '/tmp/a' } }).toolInput[
          'file_path'
        ],
      ).toBe('/tmp/a')
      expect(
        normalizeToolCall({ ...base, toolName: 'write', arguments: { [key]: '/tmp/b' } }).toolInput[
          'file_path'
        ],
      ).toBe('/tmp/b')
      expect(
        normalizeToolCall({
          ...base,
          toolName: 'edit',
          arguments: { [key]: '/tmp/c' },
        }).toolInput['file_path'],
      ).toBe('/tmp/c')
    }
  })

  it('defaults a write with no content to an empty string', () => {
    expect(
      normalizeToolCall({ ...base, toolName: 'write', arguments: { file_path: '/tmp/a' } })
        .toolInput['content'],
    ).toBe('')
  })

  it('accepts alternate key spellings for edit strings and a patch body', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'edit',
      arguments: {
        file_path: '/tmp/a',
        oldString: 'a',
        newString: 'b',
        input: '*** Begin Patch',
      },
    })
    expect(request.toolInput['old_string']).toBe('a')
    expect(request.toolInput['new_string']).toBe('b')
    expect(request.toolInput['patch']).toBe('*** Begin Patch')
  })

  it('accepts the skill alias for a skill name', () => {
    expect(
      normalizeToolCall({ ...base, toolName: 'skill', arguments: { skill: 'review' } }).toolInput[
        'name'
      ],
    ).toBe('review')
  })

  it('carries a web_fetch prompt through when present', () => {
    const request = normalizeToolCall({
      ...base,
      toolName: 'web_fetch',
      arguments: { url: 'https://x.dev', prompt: 'summarize' },
    })
    expect(request.toolInput['prompt']).toBe('summarize')
  })

  it('accepts either allowed-domains key spelling for a web search', () => {
    expect(
      normalizeToolCall({
        ...base,
        toolName: 'web_search',
        arguments: { query: 'x', allowedDomains: ['a.dev'] },
      }).toolInput['allowed_domains'],
    ).toEqual(['a.dev'])
    expect(
      normalizeToolCall({
        ...base,
        toolName: 'websearch',
        arguments: { query: 'x', allowed_domains: ['b.dev'] },
      }).toolInput['allowed_domains'],
    ).toEqual(['b.dev'])
  })

  it('maps the alternate read and fetch spellings onto the same jail tool', () => {
    expect(normalizeToolCall({ ...base, toolName: 'read_image', arguments: {} }).toolName).toBe(
      JAIL_TOOL.READ,
    )
    expect(normalizeToolCall({ ...base, toolName: 'webfetch', arguments: {} }).toolName).toBe(
      JAIL_TOOL.WEB_FETCH,
    )
  })
})
