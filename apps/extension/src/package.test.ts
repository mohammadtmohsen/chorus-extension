import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPEN_CONVERSATION_COMMAND, SET_DEEPSEEK_KEY_COMMAND } from './ids.js'

const extensionRoot = join(import.meta.dirname, '..')

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(extensionRoot, name), 'utf8')) as Record<string, unknown>

const manifest = read('package.json')
const localization = read('package.nls.json')

interface Command {
  readonly command: string
  readonly title: string
}

describe('extension manifest', () => {
  it('runs where the workspace is, not where the window is', () => {
    expect(manifest['extensionKind']).toEqual(['workspace'])
  })

  it('refuses untrusted and virtual workspaces', () => {
    const capabilities = manifest['capabilities'] as Record<string, Record<string, unknown>>
    expect(capabilities['untrustedWorkspaces']?.['supported']).toBe(false)
    expect(capabilities['virtualWorkspaces']?.['supported']).toBe(false)
  })

  it('contributes exactly the commands the code registers', () => {
    const contributes = manifest['contributes'] as { commands: readonly Command[] }
    const commands = contributes.commands.map((entry) => entry.command)
    expect(commands).toEqual([OPEN_CONVERSATION_COMMAND, SET_DEEPSEEK_KEY_COMMAND])
  })

  it('resolves every localization key it declares', () => {
    for (const [key, value] of Object.entries(manifest)) {
      if (key !== 'displayName' && key !== 'description') continue
      expect(typeof value === 'string' && value.startsWith('%') && value.endsWith('%')).toBe(true)
    }
    const referenced = new Set<string>()
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        for (const match of node.matchAll(/%([^%]+)%/g)) referenced.add(match[1] ?? '')
        return
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (node !== null && typeof node === 'object') {
        for (const value of Object.values(node)) walk(value)
      }
    }
    walk(manifest)
    for (const key of referenced) {
      expect(Object.keys(localization)).toContain(key)
    }
    expect(referenced.size).toBeGreaterThan(0)
  })

  it('points main at the built entry, and declares an l10n directory', () => {
    expect(manifest['main']).toBe('./dist/extension.js')
    expect(manifest['l10n']).toBe('./l10n')
  })
})
