import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAdapter } from '@chorus/agent-protocol'
import type { AgentId } from '@chorus/shared'
import type { ProjectRecord, RuntimeHost } from '../ports.js'

export interface TestHostOptions {
  readonly adapters: ReadonlyMap<AgentId, AgentAdapter>
  readonly model?: string
  readonly effort?: string
  readonly styleOnByDefault?: boolean
  readonly remembered?: readonly string[]
  readonly preflightApproval?: (approvalId: string) => Promise<boolean>
}

export interface TestHost {
  readonly host: RuntimeHost
  readonly dataPath: string
  readonly remembered: string[]
  readonly adopted: ProjectRecord[]
}

export function makeTestHost(options: TestHostOptions): TestHost {
  const dataPath = mkdtempSync(join(tmpdir(), 'chorus-m0-'))
  const adopted: ProjectRecord[] = []
  const remembered = [...(options.remembered ?? [])]

  const projects = {
    adopt(cwd: string): ProjectRecord {
      const existing = adopted.find((project) => project.canonicalRoot === cwd)
      if (existing !== undefined) return existing
      const project: ProjectRecord = {
        id: `project-${String(adopted.length + 1)}`,
        canonicalRoot: cwd,
        host: 'local',
      }
      adopted.push(project)
      return project
    },
    get(projectId: string): ProjectRecord | null {
      return adopted.find((project) => project.id === projectId) ?? null
    },
    resolveAgentCwd(projectId: string): string {
      const found = adopted.find((project) => project.id === projectId)
      if (found === undefined) throw new Error(`unknown project "${projectId}"`)
      return found.canonicalRoot
    },
  }

  return {
    host: {
      projects,
      grants: {
        read: () => [...remembered],
        write: (keys) => {
          remembered.length = 0
          remembered.push(...keys)
        },
      },
      settings: {
        modelFor: () => options.model ?? '',
        effortFor: () => options.effort ?? '',
        styleOnByDefault: () => options.styleOnByDefault ?? false,
      },
      adapters: options.adapters,
      dataPath,
      ...(options.preflightApproval === undefined
        ? {}
        : { preflightApproval: options.preflightApproval }),
    },
    dataPath,
    remembered,
    adopted,
  }
}
