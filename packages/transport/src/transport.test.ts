import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage } from '@chorus/collaboration-protocol'
import { createLineDecoder, encodeMessage, parseMessage } from './framing.js'
import { connectTo, listenServer, probe, type ServerConnection, type SocketServer } from './socket.js'

const socketPath = (): string => join(mkdtempSync(join(tmpdir(), 'chorus-ipc-')), 'engine.sock')

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(check: () => boolean, ticks = 400): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    if (check()) return
    await tick()
  }
}

let servers: SocketServer[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
})

describe('framing', () => {
  it('splits several messages that arrive in one chunk', () => {
    const decoder = createLineDecoder()
    const lines = decoder.push(`${encodeMessage({ n: 1 })}${encodeMessage({ n: 2 })}`)
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => parseMessage(line).value)).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('reassembles a message split across chunks', () => {
    const decoder = createLineDecoder()
    expect(decoder.push('{"n":')).toEqual([])
    const lines = decoder.push('7}\n')
    expect(lines).toHaveLength(1)
    expect(parseMessage(lines[0] ?? '').value).toEqual({ n: 7 })
  })

  it('ignores blank lines', () => {
    expect(createLineDecoder().push('\n\n')).toEqual([])
  })

  it('reports overflow once the unterminated buffer passes the limit', () => {
    const decoder = createLineDecoder(8)
    decoder.push('x'.repeat(9))
    expect(decoder.overflowed()).toBe(true)
  })

  it('reports a line that is not JSON rather than throwing', () => {
    expect(parseMessage('{oops').ok).toBe(false)
  })
})

describe('socket', () => {
  it('carries a protocol message in both directions', async () => {
    const path = socketPath()
    const received: unknown[] = []
    let serverSide: ServerConnection | undefined

    servers.push(
      await listenServer(path, (connection) => {
        serverSide = connection
        connection.onMessage((message) => {
          received.push(message)
        })
      })
    )

    const client = await connectTo(path)
    const back: unknown[] = []
    client.onMessage((message) => {
      back.push(message)
    })

    client.send({ kind: 'replay', requestId: 'r1', conversationId: 'c1' })
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ kind: 'replay', requestId: 'r1', conversationId: 'c1' }])

    serverSide?.send({
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      engineGeneration: 'g1',
    })
    await waitFor(() => back.length === 1)
    expect(back).toEqual([{ kind: 'hello', protocolVersion: PROTOCOL_VERSION, engineGeneration: 'g1' }])

    client.close()
  })

  it('closes the connection when a frame is not a protocol message', async () => {
    const path = socketPath()
    let closed = false

    servers.push(
      await listenServer(path, (connection) => {
        connection.onClose(() => {
          closed = true
        })
      })
    )

    const client = await connectTo(path)
    client.send({ kind: 'nonsense' } as unknown as ClientMessage)

    await waitFor(() => closed)
    expect(closed).toBe(true)
  })

  it('keeps the connection open for a well-formed frame', async () => {
    const path = socketPath()
    let closed = false

    servers.push(
      await listenServer(path, (connection) => {
        connection.onClose(() => {
          closed = true
        })
      })
    )

    const client = await connectTo(path)
    client.send({ kind: 'replay', requestId: 'r1', conversationId: 'c1' })
    await tick()
    await tick()

    expect(closed).toBe(false)
    expect(client.closed).toBe(false)

    client.close()
  })

  it('probes a live socket and a path with nothing behind it', async () => {
    const path = socketPath()
    expect(await probe(path, 100)).toBe(false)

    servers.push(await listenServer(path, () => undefined))
    expect(await probe(path, 100)).toBe(true)
  })
})
