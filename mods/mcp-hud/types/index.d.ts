export type ServerStatus = 'connected' | 'pending' | 'needs-auth' | 'failed' | 'disabled'

export type McpTool = {
  /** The wire name the model calls: `mcp__<server>__<tool>`. */
  name: string
  /** The tool's own name on its server. */
  short: string
  /** Estimated tokens of its schema in the context. */
  tokens: number
  /** False while its schema waits behind ToolSearch. */
  isLoaded: boolean
}

export type McpServer = {
  /** The server as tool names spell it (`claude_ai_Gmail`). */
  key: string
  /** The server as /mcp lists it (`claude.ai Gmail`). */
  name: string
  status: ServerStatus
  tools: McpTool[]
  error?: string
}

/** One tool's calls in this chat, keyed by its wire name. */
export type ToolUse = {
  calls: number
  errors: number
  running: number
  bySubagents: number
  lastAt: number
  totalMs: number
}

export type View = {
  filter: 'all' | 'used'
  /** Keys of the servers whose tools are shown. */
  expanded: string[]
  query: string
  refreshedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-hud': {
      servers: Shaped<McpServer[]>
      usage: Shaped<Record<string, ToolUse>>
      view: Shaped<View>
      now: number
    }
  }
}
