import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { CollaborationRuntime } from '@chorus/collaboration-runtime'
import type { LedgerEntry, StoredEvent } from '@chorus/event-store'
import {
  CommandResultSchema,
  PROTOCOL_VERSION,
  RuntimeDescriptorSchema,
  toApprovalDecision,
  toUserQuestionResponse,
  type ClientMessage,
  type CommandEnvelope,
  type CommandResult,
  type ConversationCommand,
  type RuntimeDescriptor,
} from '@chorus/collaboration-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { listenServer, probe, type ServerConnection } from '@chorus/transport'
import { makeEngineHost } from './host.js'
import { DEFAULT_BUILD, DESCRIPTOR_FILE, engineDataPath, socketPathFor } from './layout.js'
import type { Credentials } from './providers.js'

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const HANDSHAKE_TIMEOUT_MS = 5_000

export interface ServeOptions {
  readonly root: string
  readonly storagePath: string
  readonly adapters: ReadonlyMap<AgentId, AgentAdapter>
  readonly credentials: Credentials
  readonly log: Logger
  readonly build?: string
  readonly idleTimeoutMs?: number
}

export interface RunningEngine {
  readonly descriptor: RuntimeDescriptor
  readonly runtime: CollaborationRuntime
  readonly dataPath: string
  close(): Promise<void>
}

function readDescriptor(path: string): RuntimeDescriptor | null {
  try {
    const parsed = RuntimeDescriptorSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function existingEngine(options: {
  root: string
  storagePath: string
  build?: string
}): Promise<RuntimeDescriptor | null> {
  const canonicalRoot = realpathSync(options.root)
  const descriptorPath = join(engineDataPath(options.storagePath, canonicalRoot), DESCRIPTOR_FILE)
  const existing = readDescriptor(descriptorPath)
  if (existing === null) return null

  const build = options.build ?? DEFAULT_BUILD
  if (existing.build !== build) return null
  return (await probe(existing.socketPath, 200)) ? existing : null
}

export async function serve(options: ServeOptions): Promise<RunningEngine> {
  const canonicalRoot = realpathSync(options.root)
  const dataPath = engineDataPath(options.storagePath, canonicalRoot)
  mkdirSync(dataPath, { recursive: true })

  const build = options.build ?? DEFAULT_BUILD
  const descriptorPath = join(dataPath, DESCRIPTOR_FILE)
  const socketPath = socketPathFor(canonicalRoot, build)

  const running = await existingEngine({
    root: canonicalRoot,
    storagePath: options.storagePath,
    build,
  })
  if (running !== null) {
    throw new Error(`an engine is already serving ${canonicalRoot}`)
  }

  const engineGeneration = randomUUID()
  const token = randomBytes(32).toString('hex')

  const runtime = CollaborationRuntime.open(
    makeEngineHost({ canonicalRoot, dataPath, adapters: options.adapters }).host,
    options.log
  )

  let closed = false
  let idleTimer: NodeJS.Timeout | undefined
  const clients = new Set<ServerConnection>()
  /** The subset that finished the handshake, and so may be told anything. */
  const subscribers = new Set<ServerConnection>()

  const stopPush = runtime.subscribe((events) => {
    if (events.length === 0 || subscribers.size === 0) return

    const byConversation = new Map<string, StoredEvent[]>()
    for (const event of events) {
      const batch = byConversation.get(event.conversationId)
      if (batch === undefined) byConversation.set(event.conversationId, [event])
      else batch.push(event)
    }

    for (const [conversationId, batch] of byConversation) {
      for (const connection of subscribers) {
        connection.send({ kind: 'events', conversationId, events: batch })
      }
    }
  })

  function armIdleTimer(): void {
    clearTimeout(idleTimer)
    const timeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    if (timeout <= 0) return

    idleTimer = setTimeout(() => {
      if (clients.size > 0) {
        armIdleTimer()
        return
      }
      const busy = runtime
        .activeConversations()
        .some((conversationId) => runtime.transcriptState(conversationId).working.length > 0)
      if (busy) {
        armIdleTimer()
        return
      }
      void shutdown()
    }, timeout)
    idleTimer.unref()
  }

  async function shutdown(): Promise<void> {
    if (closed) return
    closed = true
    clearTimeout(idleTimer)
    stopPush()
    subscribers.clear()
    await server.close()

    const current = readDescriptor(descriptorPath)
    if (current !== null && current.engineGeneration === engineGeneration) {
      rmSync(descriptorPath, { force: true })
    }

    await runtime.close()
  }

  const server = await listenServer(socketPath, (connection) => {
    clients.add(connection)
    let authorised = false

    const handshakeTimer = setTimeout(() => {
      if (!authorised) connection.close()
    }, HANDSHAKE_TIMEOUT_MS)

    connection.onClose(() => {
      clearTimeout(handshakeTimer)
      clients.delete(connection)
      subscribers.delete(connection)
      armIdleTimer()
    })

    connection.onMessage((message) => {
      if (!authorised) {
        if (message.kind !== 'hello' || message.token !== token) {
          connection.send({ kind: 'rejected', requestId: '', code: 'unauthorised' })
          connection.close()
          return
        }
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          connection.send({ kind: 'rejected', requestId: '', code: 'unsupported-version' })
          connection.close()
          return
        }
        authorised = true
        clearTimeout(handshakeTimer)
        subscribers.add(connection)
        connection.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, engineGeneration })
        return
      }
      void dispatch(connection, message)
    })
  })

  async function dispatch(connection: ServerConnection, message: ClientMessage): Promise<void> {
    if (message.kind === 'replay') {
      connection.send({
        kind: 'replay',
        requestId: message.requestId,
        batch: {
          conversationId: message.conversationId,
          throughSeq: runtime.logPosition(),
          events: runtime.history(message.conversationId, message.afterSeq),
          state: runtime.transcriptState(message.conversationId),
        },
      })
      return
    }
    if (message.kind !== 'command') return
    const result = await run(message.envelope)
    connection.send({ kind: 'result', result })
  }

  async function run(envelope: CommandEnvelope): Promise<CommandResult> {
    const { requestId, command } = envelope

    if (closed) return { status: 'rejected', requestId, code: 'engine-shutting-down' }
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      return { status: 'rejected', requestId, code: 'unsupported-version' }
    }
    if (envelope.engineGeneration !== engineGeneration) {
      return { status: 'rejected', requestId, code: 'engine-generation-mismatch' }
    }

    const named: string | null = 'conversationId' in command ? command.conversationId : null
    const known = runtime.ledger.recall(requestId)
    if (known !== null) return recall(known, requestId)

    runtime.ledger.claim(requestId, named)
    const result = await apply(command, requestId)
    runtime.ledger.settle(
      requestId,
      result.status === 'rejected' ? named : (result.conversationId ?? named),
      result
    )
    return result
  }

  function recall(known: LedgerEntry, requestId: string): CommandResult {
    const uncertain: CommandResult = {
      status: 'uncertain',
      requestId,
      ...(known.conversationId === null ? {} : { conversationId: known.conversationId }),
    }

    if (known.state === 'pending') return uncertain
    const parsed = CommandResultSchema.safeParse(known.result)
    if (!parsed.success) return uncertain
    if (parsed.data.status !== 'accepted') return parsed.data

    return {
      status: 'duplicate',
      requestId,
      ...(parsed.data.conversationId === undefined
        ? {}
        : { conversationId: parsed.data.conversationId }),
    }
  }

  async function apply(command: ConversationCommand, requestId: string): Promise<CommandResult> {
    try {
      switch (command.type) {
        case 'conversation.create': {
          const room = await runtime.startConversationIn({
            cwd: canonicalRoot,
            agents: command.participants,
            profileId: command.profileId,
          })
          return { status: 'accepted', requestId, conversationId: room.conversationId }
        }
        case 'conversation.send':
          await runtime.send(command.conversationId, command.text)
          return { status: 'accepted', requestId, conversationId: command.conversationId }
        case 'conversation.interrupt':
          await runtime.interrupt(command.conversationId)
          return { status: 'accepted', requestId, conversationId: command.conversationId }
        case 'approval.decide':
          await runtime.decideApproval(
            command.conversationId,
            command.agentId,
            command.approvalId,
            toApprovalDecision(command.decision)
          )
          return { status: 'accepted', requestId, conversationId: command.conversationId }
        case 'question.answer':
          await runtime.answerUserInput(
            command.conversationId,
            command.agentId,
            command.userInputId,
            toUserQuestionResponse(command.response)
          )
          return { status: 'accepted', requestId, conversationId: command.conversationId }
        case 'credential.set':
          options.credentials.set(command.agentId, command.key)
          return { status: 'accepted', requestId }
        case 'credential.clear':
          options.credentials.clear(command.agentId)
          return { status: 'accepted', requestId }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (/is not active/.test(detail)) {
        return { status: 'rejected', requestId, code: 'unknown-conversation', detail }
      }
      if (/is not in this conversation/.test(detail)) {
        return { status: 'rejected', requestId, code: 'unknown-agent', detail }
      }
      options.log.error('a command failed', error, { requestId, type: command.type })
      return { status: 'rejected', requestId, code: 'failed', detail }
    }
  }

  const descriptor: RuntimeDescriptor = {
    protocolVersion: PROTOCOL_VERSION,
    engineGeneration,
    socketPath,
    token,
    pid: process.pid,
    dataPath,
    build,
  }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })

  armIdleTimer()
  options.log.info('engine listening', { canonicalRoot, socketPath, engineGeneration })

  return {
    descriptor,
    runtime,
    dataPath,
    close: shutdown,
  }
}
