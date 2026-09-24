import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type ConversationCommand,
  type ServerMessage,
} from '@chorus/collaboration-protocol'
import { FakeAdapter } from '@chorus/orchestrator'
import { Logger, type AgentId } from '@chorus/shared'
import { connectTo, type ClientConnection } from '@chorus/transport'
import { createCredentials } from './providers.js'
import { existingEngine, serve, type RunningEngine } from './server.js'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(check: () => boolean, ticks = 600): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    if (check()) return
    await tick()
  }
}

let requestCounter = 0
const nextRequestId = (): string => `req-${String(++requestCounter)}`

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const engines: RunningEngine[] = []
const clients: ClientConnection[] = []

afterEach(async () => {
  for (const client of clients) client.close()
  clients.length = 0
  for (const engine of engines) await engine.close()
  engines.length = 0
})

async function start(
  root: string,
  storage: string,
  ids: AgentId[] = ['claude'],
  build?: string
): Promise<RunningEngine> {
  const engine = await serve({
    root,
    storagePath: storage,
    adapters: new Map(ids.map((id) => [id, new FakeAdapter({ id })])),
    credentials: createCredentials(),
    log: new Logger({ minLevel: 'error' }),
    idleTimeoutMs: 0,
    ...(build === undefined ? {} : { build }),
  })
  engines.push(engine)
  return engine
}

interface Session {
  readonly client: ClientConnection
  readonly replies: ServerMessage[]
}

async function open(engine: RunningEngine, token?: string): Promise<Session> {
  const client = await connectTo(engine.descriptor.socketPath)
  clients.push(client)
  const replies: ServerMessage[] = []
  client.onMessage((message) => {
    replies.push(message)
  })
  client.send({
    kind: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    token: token ?? engine.descriptor.token,
  })
  await waitFor(() => replies.length >= 1)
  return { client, replies }
}

function envelope(
  engine: RunningEngine,
  command: ConversationCommand,
  requestId = nextRequestId()
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    engineGeneration: engine.descriptor.engineGeneration,
    command,
  }
}

const results = (session: Session): ServerMessage[] =>
  session.replies.filter((message) => message.kind === 'result')

async function createRoom(session: Session, engine: RunningEngine): Promise<string> {
  session.client.send({
    kind: 'command',
    envelope: envelope(engine, {
      type: 'conversation.create',
      participants: ['claude'],
      profileId: 'read-only',
    }),
  })
  await waitFor(() => results(session).length >= 1)
  const first = results(session)[0]
  return first?.kind === 'result' && first.result.status === 'accepted'
    ? (first.result.conversationId ?? '')
    : ''
}

async function replay(session: Session, conversationId: string): Promise<readonly string[]> {
  session.client.send({ kind: 'replay', requestId: 'replay-1', conversationId })
  await waitFor(() => session.replies.some((message) => message.kind === 'replay'))
  const batch = session.replies.find((message) => message.kind === 'replay')
  return batch?.kind === 'replay' ? batch.batch.events.map((event) => event.payload.type) : []
}

describe('engine server', () => {
  it('handshakes, creates a conversation and accepts a message', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'))
    const session = await open(engine)

    expect(session.replies[0]).toEqual({
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      engineGeneration: engine.descriptor.engineGeneration,
    })

    const conversationId = await createRoom(session, engine)
    expect(conversationId).not.toBe('')

    session.client.send({
      kind: 'command',
      envelope: envelope(
        engine,
        { type: 'conversation.send', conversationId, text: '@claude hello' },
        nextRequestId()
      ),
    })
    await waitFor(() => results(session).length >= 2)
    const sent = results(session)[1]
    expect(sent?.kind === 'result' ? sent.result.status : null).toBe('accepted')
  })

  it('pushes events to an attached client without being asked', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'), ['claude'], 'build-p')
    const session = await open(engine)
    const conversationId = await createRoom(session, engine)

    const before = session.replies.length
    session.client.send({
      kind: 'command',
      envelope: envelope(
        engine,
        { type: 'conversation.send', conversationId, text: '@claude hello' },
        nextRequestId()
      ),
    })

    await waitFor(() => session.replies.slice(before).some((message) => message.kind === 'events'))
    const pushed = session.replies.slice(before).find((message) => message.kind === 'events')

    expect(pushed?.kind).toBe('events')
    expect(pushed?.kind === 'events' && pushed.conversationId).toBe(conversationId)
    expect(pushed?.kind === 'events' && pushed.events.length).toBeGreaterThan(0)
  })

  it('replays what the conversation actually recorded', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'))
    const session = await open(engine)
    const conversationId = await createRoom(session, engine)

    session.client.send({
      kind: 'command',
      envelope: envelope(
        engine,
        { type: 'conversation.send', conversationId, text: '@claude hello' },
        nextRequestId()
      ),
    })
    await waitFor(() => results(session).length >= 2)

    const types = await replay(session, conversationId)
    expect(types).toContain('conversation.created')
    expect(types).toContain('user.message')
  })

  it('refuses a client that does not present the token', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'))
    const session = await open(engine, 'not-the-token')

    expect(session.replies[0]).toEqual({ kind: 'rejected', requestId: '', code: 'unauthorised' })
    await waitFor(() => session.client.closed)
    expect(session.client.closed).toBe(true)
  })

  it('refuses a second engine for the same root', async () => {
    const root = tempDir('chorus-root-')
    const storage = tempDir('chorus-store-')
    await start(root, storage, ['claude'], 'build-a')
    await expect(start(root, storage, ['claude'], 'build-a')).rejects.toThrow(/already serving/)
  })

  it('never attaches across builds, so a replaced extension cannot reach old code', async () => {
    const root = tempDir('chorus-root-')
    const storage = tempDir('chorus-store-')
    const before = await start(root, storage, ['claude'], 'build-a')
    const after = await start(root, storage, ['claude'], 'build-b')

    expect(after.descriptor.build).toBe('build-b')
    expect(after.descriptor.socketPath).not.toBe(before.descriptor.socketPath)
    expect(await existingEngine({ root, storagePath: storage, build: 'build-b' })).not.toBeNull()
    expect(await existingEngine({ root, storagePath: storage, build: 'build-a' })).toBeNull()
  })

  it('does not answer for a descriptor that predates the build field', async () => {
    const root = tempDir('chorus-root-')
    const storage = tempDir('chorus-store-')
    const engine = await start(root, storage, ['claude'], 'build-a')

    const descriptorPath = join(engine.dataPath, 'runtime.json')
    const written = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>
    delete written['build']
    writeFileSync(descriptorPath, JSON.stringify(written))

    expect(await existingEngine({ root, storagePath: storage, build: 'build-a' })).toBeNull()
  })

  it('serves the same events after the engine is stopped and started again', async () => {
    const root = tempDir('chorus-root-')
    const storage = tempDir('chorus-store-')

    const first = await start(root, storage)
    const initial = await open(first)
    const conversationId = await createRoom(initial, first)
    initial.client.send({
      kind: 'command',
      envelope: envelope(
        first,
        { type: 'conversation.send', conversationId, text: '@claude remember this' },
        nextRequestId()
      ),
    })
    await waitFor(() => results(initial).length >= 2)
    await first.close()

    const second = await start(root, storage)
    const reopened = await open(second)
    const types = await replay(reopened, conversationId)

    expect(types).toContain('conversation.created')
    expect(types).toContain('user.message')
  })

  it('applies a retried command once, and says so the second time', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'))
    const session = await open(engine)
    const conversationId = await createRoom(session, engine)

    const requestId = nextRequestId()
    const command: ConversationCommand = {
      type: 'conversation.send',
      conversationId,
      text: '@claude hello',
    }

    session.client.send({ kind: 'command', envelope: envelope(engine, command, requestId) })
    await waitFor(() => results(session).length >= 2)
    session.client.send({ kind: 'command', envelope: envelope(engine, command, requestId) })
    await waitFor(() => results(session).length >= 3)

    const first = results(session)[1]
    const second = results(session)[2]
    expect(first?.kind === 'result' ? first.result.status : null).toBe('accepted')
    expect(second?.kind === 'result' ? second.result.status : null).toBe('duplicate')
    expect(
      second?.kind === 'result' && second.result.status === 'duplicate'
        ? second.result.conversationId
        : null
    ).toBe(conversationId)

    const types = await replay(session, conversationId)
    expect(types.filter((type) => type === 'user.message')).toHaveLength(1)
  })

  it('reports a command it cannot vouch for rather than applying it again', async () => {
    const engine = await start(tempDir('chorus-root-'), tempDir('chorus-store-'))
    const session = await open(engine)
    const conversationId = await createRoom(session, engine)

    const requestId = nextRequestId()
    engine.runtime.ledger.claim(requestId, conversationId)

    session.client.send({
      kind: 'command',
      envelope: envelope(
        engine,
        { type: 'conversation.send', conversationId, text: '@claude hello' },
        requestId
      ),
    })
    await waitFor(() => results(session).length >= 2)

    const answer = results(session)[1]
    expect(answer?.kind === 'result' ? answer.result.status : null).toBe('uncertain')

    const types = await replay(session, conversationId)
    expect(types).not.toContain('user.message')
  })
})
