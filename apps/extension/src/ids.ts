export const OPEN_CONVERSATION_COMMAND = 'chorusCollaboration.openConversation'

export const SET_DEEPSEEK_KEY_COMMAND = 'chorusCollaboration.setDeepSeekKey'

export const AGENTS = ['claude', 'codex', 'deepseek'] as const

export const DEFAULT_PROFILE_ID = 'read-only'

/** Where the provider key rests. VS Code's SecretStorage, keyed per extension. */
export const DEEPSEEK_SECRET = 'chorus.deepseek.key'

export const CONVERSATION_STATE_KEY = 'chorus.conversationId'

export const DRAFT_STATE_KEY = 'chorus.draft'
