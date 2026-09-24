export const MAX_MESSAGE_BYTES = 1024 * 1024

export const FRAME_DELIMITER = '\n'

export interface ParseResult {
  readonly ok: boolean
  readonly value?: unknown
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}${FRAME_DELIMITER}`
}

export function parseMessage(line: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(line) as unknown }
  } catch {
    return { ok: false }
  }
}

export interface LineDecoder {
  push(chunk: string): readonly string[]
  overflowed(): boolean
}

export function createLineDecoder(maxBytes: number = MAX_MESSAGE_BYTES): LineDecoder {
  let buffer = ''
  let overflowed = false

  return {
    push(chunk: string): readonly string[] {
      buffer += chunk
      const lines: string[] = []
      let index = buffer.indexOf(FRAME_DELIMITER)

      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() !== '') lines.push(line)
        index = buffer.indexOf(FRAME_DELIMITER)
      }

      if (buffer.length > maxBytes) {
        overflowed = true
        buffer = ''
      }

      return lines
    },
    overflowed: () => overflowed,
  }
}
