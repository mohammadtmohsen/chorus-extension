import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@chorus/collaboration-protocol'
import { createLineDecoder, encodeMessage, parseMessage } from './framing.js'

export interface Connection<Incoming, Outgoing> {
  send(message: Outgoing): boolean
  onMessage(listener: (message: Incoming) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
  readonly closed: boolean
}

export type ClientConnection = Connection<ServerMessage, ClientMessage>
export type ServerConnection = Connection<ClientMessage, ServerMessage>

type Validator<T> = (value: unknown) => T | null

function validateClientMessage(value: unknown): ClientMessage | null {
  const parsed = ClientMessageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function validateServerMessage(value: unknown): ServerMessage | null {
  const parsed = ServerMessageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function wrap<Incoming, Outgoing>(socket: Socket, validate: Validator<Incoming>): Connection<Incoming, Outgoing> {
  const decoder = createLineDecoder()
  const messageListeners = new Set<(message: Incoming) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    for (const listener of closeListeners) listener()
    messageListeners.clear()
    closeListeners.clear()
  }

  const reject = (): void => {
    socket.destroy()
    finish()
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const line of decoder.push(text)) {
      const parsed = parseMessage(line)
      if (!parsed.ok) {
        reject()
        return
      }
      const message = validate(parsed.value)
      if (message === null) {
        reject()
        return
      }
      for (const listener of messageListeners) listener(message)
    }
    if (decoder.overflowed()) reject()
  })
  socket.on('error', finish)
  socket.on('close', finish)

  return {
    send(message: Outgoing): boolean {
      if (closed) return false
      return socket.write(encodeMessage(message))
    },
    onMessage(listener: (message: Incoming) => void): () => void {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    onClose(listener: () => void): () => void {
      closeListeners.add(listener)
      return () => {
        closeListeners.delete(listener)
      }
    },
    close(): void {
      socket.end()
      finish()
    },
    get closed(): boolean {
      return closed
    },
  }
}

export interface SocketServer {
  readonly path: string
  close(): Promise<void>
}

export function listenServer(
  path: string,
  onConnection: (connection: ServerConnection) => void
): Promise<SocketServer> {
  if (existsSync(path)) unlinkSync(path)

  return new Promise<SocketServer>((resolve, reject) => {
    const live = new Set<Socket>()

    const server: Server = createServer((socket) => {
      live.add(socket)
      socket.on('close', () => {
        live.delete(socket)
      })
      onConnection(wrap<ClientMessage, ServerMessage>(socket, validateClientMessage))
    })

    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      chmodSync(path, 0o600)
      resolve({
        path,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of live) socket.destroy()
            live.clear()
            server.close(() => {
              if (existsSync(path)) unlinkSync(path)
              done()
            })
          }),
      })
    })
  })
}

export function connectTo(path: string): Promise<ClientConnection> {
  return new Promise<ClientConnection>((resolve, reject) => {
    const socket = netConnect(path)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(wrap<ServerMessage, ClientMessage>(socket, validateServerMessage))
    })
  })
}

export function probe(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect(path)

    const settle = (alive: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(alive)
    }

    socket.once('connect', () => {
      settle(true)
    })
    socket.once('error', () => {
      settle(false)
    })
    socket.setTimeout(timeoutMs, () => {
      settle(false)
    })
  })
}
