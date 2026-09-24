import { parseArgs } from 'node:util'
import type { AgentAdapter } from '@mohammadtmohsen/agent-protocol'
import { Logger, isAgentId, type AgentId } from '@mohammadtmohsen/shared'
import { NATIVE_AGENTS, createAdapters, createCredentials } from './providers.js'
import { existingEngine, serve } from './server.js'

async function fakeAdapters(ids: readonly AgentId[]): Promise<Map<AgentId, AgentAdapter>> {
  const { FakeAdapter } = await import('@mohammadtmohsen/orchestrator')
  return new Map(ids.map((id) => [id, new FakeAdapter({ id })]))
}

const USAGE =
  'usage: chorus-engine --root <dir> --storage <dir> [--agents claude,codex] [--idle-timeout-ms n] [--fake]'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      storage: { type: 'string' },
      agents: { type: 'string', default: 'claude,codex' },
      'idle-timeout-ms': { type: 'string' },
      build: { type: 'string' },
      fake: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const root = values.root
  const storage = values.storage
  if (root === undefined || storage === undefined) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 2
    return
  }

  const ids: AgentId[] = []
  for (const raw of values.agents.split(',')) {
    const name = raw.trim()
    if (name === '') continue
    if (!isAgentId(name)) throw new Error(`unknown agent "${name}"`)
    ids.push(name)
  }

  const credentials = createCredentials()
  const adapters: Map<AgentId, AgentAdapter> = values.fake
    ? await fakeAdapters(ids)
    : await createAdapters(ids, credentials)

  for (const id of ids) {
    if (!adapters.has(id)) {
      process.stderr.write(
        `no adapter exists for "${id}"; this engine can drive ${NATIVE_AGENTS.join(', ')}\n`
      )
      process.exitCode = 2
      return
    }
  }

  const build = values.build

  const attached = await existingEngine({
    root,
    storagePath: storage,
    ...(build === undefined ? {} : { build }),
  })
  if (attached !== null) {
    process.stdout.write(`${JSON.stringify(attached)}\n`)
    return
  }

  const log = new Logger({ minLevel: 'info' })
  const idle = values['idle-timeout-ms']

  const engine = await serve({
    root,
    storagePath: storage,
    adapters,
    credentials,
    log,
    ...(build === undefined ? {} : { build }),
    ...(idle === undefined ? {} : { idleTimeoutMs: Number(idle) }),
  })

  process.stdout.write(`${JSON.stringify(engine.descriptor)}\n`)

  const stop = (): void => {
    void engine.close().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

await main()
