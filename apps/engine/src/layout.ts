import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DESCRIPTOR_FILE = 'runtime.json'
export const GRANTS_FILE = 'remembered.json'
export const SETTINGS_FILE = 'settings.json'

export const SOCKET_DIR_NAME = 'chorus-ipc'

/**
 * A unix socket path may not exceed roughly 104 bytes on macOS, including the
 * terminator. It is not a filesystem limit — a long path fails by never
 * creating the socket at all, while `listening` still fires, so the failure
 * looks like a client that cannot connect rather than an over-long name.
 *
 * The storage directory is not a safe place for the socket: VS Code's own
 * globalStorage path is already around seventy characters, and the per-project
 * partition adds another forty. Measured at 116 bytes before this changed.
 */
export const MAX_SOCKET_PATH_BYTES = 100

export function rootKey(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot).digest('hex')
}

export function engineDataPath(storagePath: string, canonicalRoot: string): string {
  return join(storagePath, 'projects', rootKey(canonicalRoot).slice(0, 32))
}

export const DEFAULT_BUILD = 'unknown'

export function socketPathFor(canonicalRoot: string, build: string = DEFAULT_BUILD): string {
  const directory = join(tmpdir(), SOCKET_DIR_NAME)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const key = createHash('sha256').update(`${canonicalRoot}\n${build}`).digest('hex')
  const path = join(directory, `${key.slice(0, 16)}.sock`)
  if (path.length > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `this socket path is ${String(path.length)} bytes and the platform allows about ${String(MAX_SOCKET_PATH_BYTES)}: ${path}`
    )
  }
  return path
}
