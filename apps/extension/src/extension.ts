import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { CommandResult, ConversationCommand } from '@chorus/collaboration-protocol'
import {
  EngineClientError,
  connectEngine,
  describeRefusal,
  type EngineClient,
  type EngineErrorCode,
} from './engine-client.js'
import { createConversationPanel, type ConversationPanel } from './conversation-panel.js'
import {
  AGENTS,
  CONVERSATION_STATE_KEY,
  DEEPSEEK_SECRET,
  DEFAULT_PROFILE_ID,
  DRAFT_STATE_KEY,
  OPEN_CONVERSATION_COMMAND,
  SET_DEEPSEEK_KEY_COMMAND,
} from './ids.js'

const ENGINE_MESSAGES: Record<EngineErrorCode, string> = {
  'start-timeout': 'The engine did not report a descriptor in time.',
  'bad-descriptor': 'The engine reported a descriptor this client does not understand.',
  'version-mismatch': 'The engine speaks a different protocol version.',
  'request-timeout': 'The engine did not answer in time.',
  'unexpected-answer': 'The engine answered with something this client did not expect.',
  'engine-gone': 'The engine stopped before answering.',
}

const RETRYABLE: readonly EngineErrorCode[] = ['request-timeout', 'engine-gone']

let client: EngineClient | undefined
let clientRoot: string | undefined
let conversationId: string | undefined
let panel: ConversationPanel | undefined
let detachEvents: (() => void) | undefined

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CONVERSATION_COMMAND, async () => {
      await openConversation(context)
    }),
    vscode.commands.registerCommand(SET_DEEPSEEK_KEY_COMMAND, async () => {
      await setDeepSeekKey(context)
    }),
    {
      dispose: () => {
        reset()
      },
    }
  )
}

export function deactivate(): void {
  reset()
}

function resetConnection(): void {
  detachEvents?.()
  detachEvents = undefined
  client?.close()
  client = undefined
  clientRoot = undefined
}

function reset(): void {
  resetConnection()
  panel?.dispose()
  panel = undefined
  conversationId = undefined
}

function attach(id: string, engine: EngineClient): void {
  detachEvents?.()
  detachEvents = engine.onEvents((from, events) => {
    if (from !== id) return
    panel?.events(events)
  })
}

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders
  if (folders === undefined || folders.length !== 1) return undefined
  return folders[0]?.uri.fsPath
}

async function engineFor(context: vscode.ExtensionContext, root: string): Promise<EngineClient> {
  if (client !== undefined && clientRoot === root) return client

  resetConnection()

  const engineMain = join(context.extensionUri.fsPath, 'engine', 'main.js')
  if (!existsSync(engineMain)) {
    throw new Error(vscode.l10n.t('The engine is missing from this install: {0}', engineMain))
  }

  client = await connectEngine({
    root,
    storagePath: context.globalStorageUri.fsPath,
    engineMain,
    nodePath: process.execPath,
    agents: AGENTS,
    build: createHash('sha256').update(readFileSync(engineMain)).digest('hex'),
  })
  clientRoot = root
  await sendCredentials(context, client)
  return client
}

/**
 * Hands the engine whatever credentials are held, every time it connects.
 *
 * Sent rather than read because the engine cannot reach SecretStorage, and sent
 * on *every* connect rather than once because an engine is a process that comes
 * and goes — a restart, an idle exit, a version change — and each new one starts
 * with nothing. A key that was stored yesterday still arrives on the first
 * connection today.
 */
async function sendCredentials(
  context: vscode.ExtensionContext,
  engine: EngineClient
): Promise<void> {
  const key = await context.secrets.get(DEEPSEEK_SECRET)
  if (key === undefined) return
  await engine.send({ type: 'credential.set', agentId: 'deepseek', key })
}

async function sendWithRetry(
  context: vscode.ExtensionContext,
  root: string,
  command: ConversationCommand
): Promise<CommandResult> {
  const requestId = randomUUID()
  try {
    return await (await engineFor(context, root)).send(command, requestId)
  } catch (error) {
    if (!(error instanceof EngineClientError) || !RETRYABLE.includes(error.code)) throw error
    resetConnection()
    const engine = await engineFor(context, root)
    if (conversationId !== undefined) attach(conversationId, engine)
    return engine.send(command, requestId)
  }
}

async function setDeepSeekKey(context: vscode.ExtensionContext): Promise<void> {
  const entered = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(
      'Paste your DeepSeek API key. It is kept in VS Code SecretStorage, never in a settings file, and sent only to the engine.'
    ),
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? vscode.l10n.t('A key cannot be empty.') : undefined),
  })

  if (entered === undefined) return
  const key = entered.trim()
  await context.secrets.store(DEEPSEEK_SECRET, key)

  const root = workspaceRoot()
  if (root === undefined) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Saved. Open a single folder, then run this again to hand it to the engine.')
    )
    return
  }

  try {
    const engine = await engineFor(context, root)
    const result = await engine.send({ type: 'credential.set', agentId: 'deepseek', key })

    if (result.status === 'rejected') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('The engine refused the key: {0}', describeRefusal(result))
      )
      return
    }

    void vscode.window.showInformationMessage(
      vscode.l10n.t('DeepSeek is ready. Address it with @deepseek in a conversation.')
    )
  } catch (error) {
    if (error instanceof EngineClientError) {
      void vscode.window.showErrorMessage(vscode.l10n.t(ENGINE_MESSAGES[error.code]))
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(detail)
  }
}

async function conversationFor(
  context: vscode.ExtensionContext,
  engine: EngineClient
): Promise<string | undefined> {
  const remembered = conversationId ?? context.workspaceState.get<string>(CONVERSATION_STATE_KEY)

  if (remembered !== undefined) {
    const batch = await engine.replay(remembered)
    if (batch.events.length > 0) {
      conversationId = remembered
      return remembered
    }
    await context.workspaceState.update(CONVERSATION_STATE_KEY, undefined)
  }

  const created = await engine.send({
    type: 'conversation.create',
    participants: [...AGENTS],
    profileId: DEFAULT_PROFILE_ID,
  })

  if (created.status === 'rejected') {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The engine refused to open a conversation: {0}', describeRefusal(created))
    )
    return undefined
  }
  if (created.status !== 'accepted' || created.conversationId === undefined) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The engine did not open a conversation: {0}', created.status)
    )
    return undefined
  }

  conversationId = created.conversationId
  await context.workspaceState.update(CONVERSATION_STATE_KEY, created.conversationId)
  return created.conversationId
}

async function openConversation(context: vscode.ExtensionContext): Promise<void> {
  const root = workspaceRoot()
  if (root === undefined) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Open a single folder before starting a conversation.')
    )
    return
  }

  try {
    const engine = await engineFor(context, root)
    const id = await conversationFor(context, engine)
    if (id === undefined) return

    const run = (command: ConversationCommand): void => {
      void sendWithRetry(context, root, command)
        .then((result) => {
          if (result.status === 'rejected') {
            panel?.status({ text: describeRefusal(result), tone: 'error' })
            return
          }
          if (result.status === 'duplicate') {
            panel?.status({
              text: vscode.l10n.t('That command had already been applied.'),
              tone: 'info',
            })
            return
          }
          if (result.status === 'uncertain') {
            panel?.status({
              text: vscode.l10n.t(
                'The engine could not tell whether that command was applied. Read the conversation before repeating it.'
              ),
              tone: 'error',
            })
          }
        })
        .catch(() => {
          panel?.status({ text: vscode.l10n.t('The engine stopped before answering.'), tone: 'error' })
        })
    }

    panel?.dispose()
    panel = createConversationPanel(context, 'Chorus Collaboration', {
      onReady: () => {
        panel?.draft(context.workspaceState.get<string>(DRAFT_STATE_KEY) ?? '')
        void hydrate(engine, id)
      },
      onSend: (message) => {
        void context.workspaceState.update(DRAFT_STATE_KEY, '')
        run({ type: 'conversation.send', conversationId: id, text: message.text })
      },
      onDraft: (message) => {
        void context.workspaceState.update(DRAFT_STATE_KEY, message.text)
      },
      onStop: () => {
        run({ type: 'conversation.interrupt', conversationId: id })
      },
      onDecide: (message) => {
        run({
          type: 'approval.decide',
          conversationId: id,
          agentId: message.agentId,
          approvalId: message.approvalId,
          decision: message.allow
            ? { outcome: 'allow', scope: 'session' }
            : { outcome: 'deny', message: '' },
        })
      },
      onAnswer: (message) => {
        run({
          type: 'question.answer',
          conversationId: id,
          agentId: message.agentId,
          userInputId: message.userInputId,
          response: { outcome: 'answered', answers: message.answers },
        })
      },
    })

    attach(id, engine)

    await hydrate(engine, id)
  } catch (error) {
    if (error instanceof EngineClientError) {
      const message = vscode.l10n.t(ENGINE_MESSAGES[error.code])
      void vscode.window.showErrorMessage(
        error.detail === undefined ? message : `${message} ${error.detail}`
      )
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(detail)
  }
}

async function hydrate(engine: EngineClient, id: string): Promise<void> {
  const batch = await engine.replay(id)
  panel?.events(batch.events)
}
