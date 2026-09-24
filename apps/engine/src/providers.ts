import { ClaudeAdapter } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type { AgentAdapter } from '@chorus/agent-protocol'
import type { AgentId } from '@chorus/shared'
import { sdkExecutablePath, spawnSpec } from './command.js'
import { createDeepSeekAdapter } from './deepseek.js'
import { adoptShellPath, resolveCommand } from './which.js'

export const NATIVE_AGENTS: readonly AgentId[] = ['claude', 'codex', 'deepseek']

/**
 * Credentials the engine was handed, for the life of the process.
 *
 * In memory and nowhere else. The only place a provider key is allowed to rest
 * is VS Code's SecretStorage, which cannot be read from here; the engine is
 * given one, uses one, and writes none — no settings file, no log line.
 */
export interface Credentials {
  get(agentId: AgentId): string | null
  set(agentId: AgentId, key: string): void
  clear(agentId: AgentId): void
}

export function createCredentials(): Credentials {
  const held = new Map<AgentId, string>()
  return {
    get: (agentId) => held.get(agentId) ?? null,
    set: (agentId, key) => {
      held.set(agentId, key)
    },
    clear: (agentId) => {
      held.delete(agentId)
    },
  }
}

export async function createAdapters(
  agents: readonly AgentId[],
  credentials: Credentials
): Promise<Map<AgentId, AgentAdapter>> {
  await adoptShellPath()

  const adapters = new Map<AgentId, AgentAdapter>()

  for (const id of agents) {
    if (id === 'claude') {
      adapters.set(
        'claude',
        new ClaudeAdapter({
          resolveExecutable: async () => {
            const resolved = await resolveCommand('claude')
            if (resolved === null) return null
            return { sdkPath: sdkExecutablePath(resolved), launch: spawnSpec(resolved) }
          },
        })
      )
      continue
    }

    if (id === 'codex') {
      adapters.set(
        'codex',
        new CodexAdapter({
          resolveCommand: async () => {
            const resolved = await resolveCommand('codex')
            return resolved === null ? null : spawnSpec(resolved)
          },
        })
      )
      continue
    }

    if (id === 'deepseek') {
      adapters.set(
        'deepseek',
        createDeepSeekAdapter(() => credentials.get('deepseek'))
      )
    }
  }

  return adapters
}
