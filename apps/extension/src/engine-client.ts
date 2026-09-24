import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  RuntimeDescriptorSchema,
  type CommandResult,
  type ConversationCommand,
  type ReplayBatch,
  type RuntimeDescriptor,
  type ServerMessage,
  type WireStoredEvent,
} from '@chorus/collaboration-protocol'
import { connectTo } from '@chorus/transport'

export type EngineErrorCode =
  | 'start-timeout'
  | 'bad-descriptor'
  | 'version-mismatch'
  | 'request-timeout'
  | 'unexpected-answer'
  | 'engine-gone'

export class EngineClientError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    readonly detail?: string
  ) {
    super(code)
    this.name = 'EngineClientError'
  }
}

export interface EngineClient {
  readonly descriptor: RuntimeDescriptor
  send(command: ConversationCommand, requestId?: string): Promise<CommandResult>
  replay(conversationId: string, afterSeq?: number): Promise<ReplayBatch>
  /**
   * Events the engine sent without being asked.
   *
   * Separate from `replay`, which answers a question: this arrives while an
   * agent is working, and a panel that only replayed would show a conversation
   * frozen at the moment it was opened.
   */
  onEvents(
    listener: (conversationId: string, events: readonly WireStoredEvent[]) => void
  ): () => void
  close(): void
}

/**
 * The engine's reason, not just its verdict.
 *
 * A bare `rejected` is what made the first real failure unreadable: the engine
 * had said `No adapter registered for "claude"` and this discarded it, so the
 * only symptom was a status word that names neither the cause nor the component.
 */
export function describeRefusal(result: Extract<CommandResult, { status: 'rejected' }>): string {
  return result.detail === undefined ? result.code : `${result.code}: ${result.detail}`
}

export interface ConnectEngineOptions {
  readonly root: string
  readonly storagePath: string
  readonly engineMain: string
  readonly nodePath: string
  readonly agents: readonly string[]
  /**
   * Which engine this client belongs to.
   *
   * An installed extension is replaced on disk while a running engine keeps the
   * code it started with, so the two can silently disagree — which is exactly
   * what happened: a client built with providers attached to an engine built
   * without them and reported only `No adapter registered`. Passing the engine
   * bundle's own digest makes that impossible to do by accident.
   */
  readonly build: string
}

export const START_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 30_000

const HANDSHAKE_KEY = 'handshake'

function startOrAttach(options: ConnectEngineOptions): Promise<RuntimeDescriptor> {
  return new Promise<RuntimeDescriptor>((resolve, reject) => {
    const child = spawn(
      options.nodePath,
      [
        options.engineMain,
        '--root',
        options.root,
        '--storage',
        options.storagePath,
        '--agents',
        options.agents.join(','),
        '--build',
        options.build,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const detach = (): void => {
      clearTimeout(timer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }

    const fail = (code: EngineErrorCode, detail?: string): void => {
      if (settled) return
      settled = true
      detach()
      reject(new EngineClientError(code, detail))
    }

    timer = setTimeout(() => {
      fail('start-timeout')
    }, START_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) return

      settled = true
      detach()

      let raw: unknown
      try {
        raw = JSON.parse(stdout.slice(0, newline))
      } catch {
        reject(new EngineClientError('bad-descriptor'))
        return
      }

      const parsed = RuntimeDescriptorSchema.safeParse(raw)
      if (!parsed.success) {
        reject(new EngineClientError('bad-descriptor'))
        return
      }
      resolve(parsed.data)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', () => {
      fail('engine-gone')
    })
    child.on('exit', (code) => {
      fail('engine-gone', `${String(code ?? -1)}: ${stderr.trim()}`)
    })
  })
}

export async function connectEngine(options: ConnectEngineOptions): Promise<EngineClient> {
  const descriptor = await startOrAttach(options)
  const connection = await connectTo(descriptor.socketPath)

  interface Waiting {
    readonly resolve: (message: ServerMessage) => void
    readonly reject: (error: Error) => void
    readonly timer: NodeJS.Timeout
  }

  const waiting = new Map<string, Waiting>()
  const eventListeners = new Set<
    (conversationId: string, events: readonly WireStoredEvent[]) => void
  >()

  function keyOf(message: ServerMessage): string | undefined {
    if (message.kind === 'hello') return HANDSHAKE_KEY
    if (message.kind === 'result') return message.result.requestId
    if (message.kind === 'replay') return message.requestId
    if (message.kind === 'rejected') return message.requestId === '' ? HANDSHAKE_KEY : message.requestId
    return undefined
  }

  connection.onMessage((message) => {
    if (message.kind === 'events') {
      for (const listener of eventListeners) listener(message.conversationId, message.events)
      return
    }

    const key = keyOf(message)
    if (key === undefined) return
    const entry = waiting.get(key)
    if (entry === undefined) return
    waiting.delete(key)
    clearTimeout(entry.timer)
    entry.resolve(message)
  })

  connection.onClose(() => {
    for (const [key, entry] of waiting) {
      clearTimeout(entry.timer)
      entry.reject(new EngineClientError('engine-gone'))
      waiting.delete(key)
    }
  })

  function request(key: string, send: () => void): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(key)
        reject(new EngineClientError('request-timeout', key))
      }, REQUEST_TIMEOUT_MS)
      waiting.set(key, { resolve, reject, timer })
      send()
    })
  }

  const hello = await request(HANDSHAKE_KEY, () => {
    connection.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, token: descriptor.token })
  })

  if (hello.kind !== 'hello' || hello.protocolVersion !== PROTOCOL_VERSION) {
    connection.close()
    throw new EngineClientError(
      'version-mismatch',
      hello.kind === 'rejected' ? hello.code : hello.kind
    )
  }

  let counter = 0

  return {
    descriptor,
    async send(command: ConversationCommand, requestId?: string): Promise<CommandResult> {
      const id = requestId ?? randomUUID()
      const message = await request(id, () => {
        connection.send({
          kind: 'command',
          envelope: {
            protocolVersion: PROTOCOL_VERSION,
            requestId: id,
            engineGeneration: descriptor.engineGeneration,
            command,
          },
        })
      })

      if (message.kind === 'result') return message.result
      if (message.kind === 'rejected') {
        return {
          status: 'rejected',
          requestId: id,
          code: message.code,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        }
      }
      throw new EngineClientError('unexpected-answer', message.kind)
    },
    async replay(conversationId: string, afterSeq?: number): Promise<ReplayBatch> {
      const requestId = `replay-${String(++counter)}`
      const message = await request(requestId, () => {
        connection.send({
          kind: 'replay',
          requestId,
          conversationId,
          ...(afterSeq === undefined ? {} : { afterSeq }),
        })
      })

      if (message.kind === 'replay') return message.batch
      throw new EngineClientError('unexpected-answer', message.kind)
    },
    onEvents(listener): () => void {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    close(): void {
      connection.close()
    },
  }
}
