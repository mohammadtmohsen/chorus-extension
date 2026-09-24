import { describe, expect, it } from 'vitest'
import { DEEPSEEK_LONG_CONTEXT_MODEL, DEEPSEEK_MODEL, deepseekEnv } from './deepseek.js'

describe('the DeepSeek recipe', () => {
  it('points the Claude CLI at DeepSeek rather than at Anthropic', () => {
    const env = deepseekEnv('sk-test')
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.deepseek.com/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-test')
  })

  it('pins every alias, so a delegated model cannot bill at Pro rates', () => {
    const env = deepseekEnv('sk-test')
    expect(env['ANTHROPIC_MODEL']).toBe(DEEPSEEK_LONG_CONTEXT_MODEL)
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe(DEEPSEEK_LONG_CONTEXT_MODEL)
    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe(DEEPSEEK_LONG_CONTEXT_MODEL)
    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe(DEEPSEEK_MODEL)
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe(DEEPSEEK_MODEL)
  })

  it('widens the compaction window the 1M model needs', () => {
    expect(deepseekEnv('sk-test')['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('786432')
  })

  it('carries the key it was given and not some other', () => {
    const env = deepseekEnv('sk-second')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-second')
    expect(Object.values(env)).not.toContain('sk-first')
  })

  it('omits nothing rather than emitting empty values', () => {
    for (const value of Object.values(deepseekEnv('sk-test'))) {
      expect(value).not.toBe('')
    }
  })
})
