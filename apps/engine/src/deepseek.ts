import { ClaudeAdapter, anthropicManagedEnv } from '@chorus/adapter-claude'
import type { AgentAdapter, ModelChoice } from '@chorus/agent-protocol'
import { sdkExecutablePath, spawnSpec } from './command.js'
import { resolveCommand } from './which.js'

/**
 * DeepSeek is not a provider this engine has an adapter for.
 *
 * It is the `claude` binary pointed at DeepSeek's Anthropic-compatible endpoint,
 * which is why the adapter below is a `ClaudeAdapter` and why the model names
 * are DeepSeek's rather than Claude's — the endpoint maps `claude-*` names on
 * its own side, and an opus-shaped one bills at Pro rates.
 */
export const DEEPSEEK_MODEL = 'deepseek-flash'

/** The `[1m]` suffix asks for the million-token context. */
export const DEEPSEEK_LONG_CONTEXT_MODEL = 'deepseek-flash[1m]'

export const DEEPSEEK_MODELS: readonly ModelChoice[] = [
  { value: DEEPSEEK_LONG_CONTEXT_MODEL, label: 'V4.1 Flash (1M context)' },
  { value: DEEPSEEK_MODEL, label: 'V4.1 Flash' },
  { value: 'deepseek-v4-pro', label: 'V4 Pro' },
]

/**
 * Every variable DeepSeek's own Claude Code recipe sets, given a key.
 *
 * **The `ANTHROPIC_DEFAULT_*` pins and the subagent model are not decoration.**
 * Left unset, an aliased or delegated model resolves through DeepSeek's
 * `claude-opus` mapping to `deepseek-v4-pro` and bills at Pro rates for work
 * nobody asked to be expensive. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is what makes
 * the 1M context usable rather than compacting at Claude's threshold.
 */
export function deepseekEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
  }
}

/**
 * `key` is a function, not a value, and that is the whole reason this takes one.
 *
 * The credential arrives over the socket long after the adapter is built, and
 * the adapter asks for it at each spawn — so a key added, rotated or removed
 * takes effect on the next turn rather than at the next restart. A captured
 * string would be whatever was set when the engine started, which is a state the
 * person cannot see and cannot correct.
 */
export function createDeepSeekAdapter(key: () => string | null): AgentAdapter {
  return new ClaudeAdapter({
    id: 'deepseek',
    models: DEEPSEEK_MODELS,
    precondition: () =>
      key() === null
        ? 'DeepSeek needs an API key. Add one with "Chorus Collaboration: Set DeepSeek API Key".'
        : null,
    /*
     * `clear: anthropicManagedEnv` rather than `() => false`, and the difference
     * is money. The user's shell may hold `ANTHROPIC_BASE_URL` or
     * `ANTHROPIC_API_KEY` for their own account, and an inherited credential
     * takes precedence over the one injected here — so a DeepSeek session would
     * quietly authenticate, and bill, as their Claude account.
     */
    env: {
      inject: () => {
        const token = key()
        return token === null ? undefined : deepseekEnv(token)
      },
      clear: anthropicManagedEnv,
    },
    resolveExecutable: async () => {
      const resolved = await resolveCommand('claude')
      if (resolved === null) return null
      return { sdkPath: sdkExecutablePath(resolved), launch: spawnSpec(resolved) }
    },
  })
}
