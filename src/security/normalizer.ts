/**
 * Tool-call normalization.
 *
 * AgentJail speaks the Claude Code hook vocabulary: `PreToolUse` events whose
 * `tool_name` is `Bash`, `Read`, `Write`, `Edit`, `Skill`, `WebFetch`,
 * `WebSearch`, or `mcp__<server>__<tool>`, and whose `tool_input` uses that
 * vocabulary's field names. DeepSeek Harness names the same capabilities
 * `bash`, `read`, `write`, `edit`, and `mcp__<server>__<tool>`.
 *
 * This module is the single translation point between the two. Keeping it pure
 * and total means policy authors write rules once, against AgentJail's
 * documented vocabulary, and the plugin's mapping can be unit-tested without a
 * daemon or a Harness runtime.
 * @module dsh-plugin-agentjail/security/normalizer
 */

/** The Claude Code hook event vocabulary AgentJail's Rego rules consume. */
export const HOOK_EVENT = {
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
} as const

/** The AgentJail tool-name vocabulary this plugin emits. */
export const JAIL_TOOL = {
  BASH: 'Bash',
  READ: 'Read',
  WRITE: 'Write',
  EDIT: 'Edit',
  SKILL: 'Skill',
  WEB_FETCH: 'WebFetch',
  WEB_SEARCH: 'WebSearch',
  OTHER: 'Other',
} as const

/** Every normalized AgentJail tool name. */
export type JailToolName = (typeof JAIL_TOOL)[keyof typeof JAIL_TOOL]

/** One normalized policy-evaluation request in AgentJail's vocabulary. */
export interface NormalizedRequest {
  /** AgentJail hook event name. */
  hookEvent: string
  /** AgentJail tool name. */
  toolName: string
  /** Tool input translated into AgentJail's field names. */
  toolInput: Record<string, unknown>
  /** Session identity, used for per-session policy and audit correlation. */
  sessionId: string
  /** Agent identity, used for per-agent policy. */
  agentId: string
  /** Working directory the call resolves against. */
  cwd: string
  /** MCP server name when the call targets an MCP tool. */
  mcpServer?: string
  /** Raw MCP tool name when the call targets an MCP tool. */
  mcpTool?: string
  /** The original Harness tool name, retained for audit and overrides. */
  harnessToolName: string
}

/** Inputs the normalizer needs from the Harness execution. */
export interface NormalizeInput {
  /** The Harness tool name as registered on `ctx.tools`. */
  toolName: string
  /** The parsed, frozen tool arguments. */
  arguments: Record<string, unknown>
  /** Session id, when the call runs inside an agent. */
  sessionId: string
  /** Working directory the call resolves against. */
  cwd: string
}

/** The MCP server-qualified name shape Harness registers MCP tools under. */
const MCP_NAME_PATTERN = /^mcp__(?<server>[A-Za-z0-9_-]{1,64})__(?<tool>.+)$/

/**
 * Report whether a tool name is an MCP server-qualified name.
 * @param toolName - the Harness tool name.
 * @returns whether the name matches `mcp__<server>__<tool>`.
 */
export function isMcpToolName(toolName: string): boolean {
  return MCP_NAME_PATTERN.test(toolName)
}

/**
 * Split an MCP server-qualified tool name into its parts.
 * @param toolName - the Harness tool name.
 * @returns the server and raw tool names, or `undefined` for a non-MCP name.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const match = MCP_NAME_PATTERN.exec(toolName)
  const server = match?.groups?.['server']
  const tool = match?.groups?.['tool']
  if (server === undefined || tool === undefined || tool.length === 0) return undefined
  return { server, tool }
}

/**
 * Read the first present string field from an argument record.
 * @param args - the argument record.
 * @param keys - candidate field names, in priority order.
 * @returns the first string value found, or `undefined`.
 */
function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Normalize a Harness tool call into AgentJail's request vocabulary.
 *
 * Unknown tools are preserved rather than dropped: the raw name and arguments
 * are forwarded under {@link JAIL_TOOL.OTHER}, so a Rego rule can still match on
 * `input.tool_name` and `input.tool_input`. Dropping them would silently exempt
 * every tool the plugin does not recognize, which is the opposite of failing
 * closed.
 * @param input - the Harness call to normalize.
 * @returns the request fields AgentJail's evaluator consumes.
 */
export function normalizeToolCall(input: NormalizeInput): NormalizedRequest {
  const { toolName, arguments: args } = input
  const base = {
    hookEvent: HOOK_EVENT.PRE_TOOL_USE,
    sessionId: input.sessionId,
    agentId: input.sessionId,
    cwd: input.cwd,
    harnessToolName: toolName,
  }

  const mcp = parseMcpToolName(toolName)
  if (mcp !== undefined) {
    return {
      ...base,
      toolName,
      toolInput: { ...args },
      mcpServer: mcp.server,
      mcpTool: mcp.tool,
    }
  }

  switch (toolName) {
    case 'bash': {
      const command = firstString(args, ['command']) ?? ''
      const workdir = firstString(args, ['workdir', 'cwd', 'working_directory'])
      const timeoutMs = args['timeoutMs']
      const toolInput: Record<string, unknown> = { command }
      if (workdir !== undefined) toolInput['cwd'] = workdir
      if (typeof timeoutMs === 'number') toolInput['timeout'] = timeoutMs
      const justification = firstString(args, ['justification'])
      if (justification !== undefined) toolInput['justification'] = justification
      return { ...base, toolName: JAIL_TOOL.BASH, toolInput }
    }
    case 'read':
    case 'read_image': {
      const filePath = firstString(args, ['file_path', 'path', 'filePath']) ?? ''
      const toolInput: Record<string, unknown> = { file_path: filePath }
      const offset = args['offset']
      const limit = args['limit']
      if (typeof offset === 'number') toolInput['offset'] = offset
      if (typeof limit === 'number') toolInput['limit'] = limit
      return { ...base, toolName: JAIL_TOOL.READ, toolInput }
    }
    case 'write': {
      const filePath = firstString(args, ['file_path', 'path', 'filePath']) ?? ''
      const content = firstString(args, ['content']) ?? ''
      return {
        ...base,
        toolName: JAIL_TOOL.WRITE,
        toolInput: { file_path: filePath, content },
      }
    }
    case 'edit':
    case 'apply_patch': {
      const filePath = firstString(args, ['file_path', 'path', 'filePath']) ?? ''
      const toolInput: Record<string, unknown> = { file_path: filePath }
      const oldString = firstString(args, ['old_string', 'oldString'])
      const newString = firstString(args, ['new_string', 'newString'])
      if (oldString !== undefined) toolInput['old_string'] = oldString
      if (newString !== undefined) toolInput['new_string'] = newString
      const patch = firstString(args, ['patch', 'input'])
      if (patch !== undefined) toolInput['patch'] = patch
      return { ...base, toolName: JAIL_TOOL.EDIT, toolInput }
    }
    case 'skill': {
      const name = firstString(args, ['name', 'skill']) ?? ''
      return { ...base, toolName: JAIL_TOOL.SKILL, toolInput: { name } }
    }
    case 'web_fetch':
    case 'webfetch': {
      const url = firstString(args, ['url']) ?? ''
      const prompt = firstString(args, ['prompt'])
      const toolInput: Record<string, unknown> = { url }
      if (prompt !== undefined) toolInput['prompt'] = prompt
      return { ...base, toolName: JAIL_TOOL.WEB_FETCH, toolInput }
    }
    case 'web_search':
    case 'websearch': {
      const query = firstString(args, ['query']) ?? ''
      const allowedDomains = args['allowed_domains'] ?? args['allowedDomains']
      const toolInput: Record<string, unknown> = { query }
      if (allowedDomains !== undefined) toolInput['allowed_domains'] = allowedDomains
      return { ...base, toolName: JAIL_TOOL.WEB_SEARCH, toolInput }
    }
    default: {
      return {
        ...base,
        toolName: JAIL_TOOL.OTHER,
        toolInput: { raw_tool_name: toolName, ...args },
      }
    }
  }
}
