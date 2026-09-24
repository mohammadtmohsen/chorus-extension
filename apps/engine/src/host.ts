import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAdapter } from '@chorus/agent-protocol'
import type { RuntimeHost } from '@chorus/collaboration-runtime'
import type { AgentId } from '@chorus/shared'
import { GRANTS_FILE, SETTINGS_FILE, rootKey } from './layout.js'

interface StoredSettings {
  readonly models?: Record<string, string>
  readonly efforts?: Record<string, string>
  readonly styleOnByDefault?: boolean
}

export interface EngineHostOptions {
  readonly canonicalRoot: string
  readonly dataPath: string
  readonly adapters: ReadonlyMap<AgentId, AgentAdapter>
}

export interface EngineHost {
  readonly host: RuntimeHost
  readonly projectId: string
  readonly grantsPath: string
  readonly settingsPath: string
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function makeEngineHost(options: EngineHostOptions): EngineHost {
  mkdirSync(options.dataPath, { recursive: true })

  const grantsPath = join(options.dataPath, GRANTS_FILE)
  const settingsPath = join(options.dataPath, SETTINGS_FILE)
  const remembered = readJson<string[]>(grantsPath, [])
  const settings = readJson<StoredSettings>(settingsPath, {})

  const projectId = rootKey(options.canonicalRoot)
  const project = {
    id: projectId,
    canonicalRoot: options.canonicalRoot,
    host: 'local',
  }

  return {
    projectId,
    grantsPath,
    settingsPath,
    host: {
      projects: {
        adopt: () => project,
        get: (id: string) => (id === projectId ? project : null),
        resolveAgentCwd: (id: string) => {
          if (id !== projectId) throw new Error(`unknown project "${id}"`)
          if (!existsSync(options.canonicalRoot)) {
            throw new Error(`the folder for this project is gone: ${options.canonicalRoot}`)
          }
          return options.canonicalRoot
        },
      },
      grants: {
        read: () => [...remembered],
        write: (keys) => {
          remembered.length = 0
          remembered.push(...keys)
          writeJson(grantsPath, remembered)
        },
      },
      settings: {
        modelFor: (agentId: AgentId) => settings.models?.[agentId] ?? '',
        effortFor: (agentId: AgentId) => settings.efforts?.[agentId] ?? '',
        styleOnByDefault: () => settings.styleOnByDefault ?? false,
      },
      adapters: options.adapters,
      dataPath: options.dataPath,
    },
  }
}
