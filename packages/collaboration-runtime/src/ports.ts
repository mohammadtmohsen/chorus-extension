import type {
  AgentAdapter,
  AgentActivity,
  BackgroundTask,
  UsageWindow,
} from '@mohammadtmohsen/agent-protocol'
import type { AgentId } from '@mohammadtmohsen/shared'

export interface ProjectRecord {
  readonly id: string
  readonly canonicalRoot: string
  readonly host: string
  readonly profileId?: string
}

export interface ProjectPort {
  adopt(cwd: string): ProjectRecord
  get(projectId: string): ProjectRecord | null
  resolveAgentCwd(projectId: string): string
}

export interface RememberedGrantsPort {
  read(): readonly string[]
  write(keys: readonly string[]): void
}

export interface ProviderSettingsPort {
  modelFor(agentId: AgentId): string
  effortFor(agentId: AgentId): string
  styleOnByDefault(): boolean
}

export interface LimitsPush {
  readonly agentId: AgentId
  readonly windows: readonly UsageWindow[]
}

export interface ContextUsagePush {
  readonly conversationId: string
  readonly agentId: AgentId
  readonly usedTokens: number
  readonly maxTokens: number
  readonly percentUsed: number
  readonly autoCompactThreshold: number | null
  readonly autoCompactPercent: number | null
  readonly autoCompactEnabled: boolean
}

export interface TasksPush {
  readonly conversationId: string
  readonly agentId: AgentId
  readonly tasks: readonly BackgroundTask[]
}

export interface ActivityPush {
  readonly conversationId: string
  readonly agentId: AgentId
  readonly activity: AgentActivity | null
}

export interface RuntimeNotifications {
  readonly onLimits?: (push: LimitsPush) => void
  readonly onContextUsage?: (push: ContextUsagePush) => void
  readonly onTasks?: (push: TasksPush) => void
  readonly onActivity?: (push: ActivityPush) => void
  readonly onConversationsChanged?: () => void
}

export interface RuntimeHost {
  readonly projects: ProjectPort
  readonly grants: RememberedGrantsPort
  readonly settings: ProviderSettingsPort
  readonly adapters: ReadonlyMap<AgentId, AgentAdapter>
  readonly dataPath: string
  readonly notifications?: RuntimeNotifications
  readonly preflightApproval?: (approvalId: string) => Promise<boolean>
}
