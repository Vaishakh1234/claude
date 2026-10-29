export type Phase = 'plan' | 'work' | 'review' | 'done'

/** What the main session reports through the `progress` tool. */
export type Plan = {
  title: string
  total: number
  done: number
  phase: Phase
  isFinished: boolean
  /** Planned task titles, matched to subagent descriptions. */
  tasks: string[]
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** The latest request's prompt plus output: how full the context is. */
  contextTokens: number
  /** Every request's tokens added up. */
  tokens: number
  costUsd: number
  requests: number
  /** Self-reported by the subagent through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type View = {
  isDoneHidden: boolean
  isBandHidden: boolean
  hasAutoOpened: boolean
  /** When the current batch of subagents started: the band counts from here. */
  batchStartedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agents-hud': {
      plan: Shaped<Plan | null>
      agents: Shaped<AgentRun[]>
      view: Shaped<View>
      now: number
    }
  }
}
