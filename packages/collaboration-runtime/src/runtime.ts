import { existsSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  mergeUsageWindows,
  type ApprovalDecision,
  type SessionOpts,
  type UsageWindow,
  type UserInputResponse,
} from '@chorus/agent-protocol'
import {
  CommandLedger,
  EventStore,
  openSqlite,
  type SqliteHandle,
  type StoredEvent,
  type TranscriptState,
} from '@chorus/event-store'
import {
  callRule,
  composeCarryover,
  composeHistory,
  ConversationService,
  findReplyHandoff,
  parseMentions,
  profileById,
  PROFILES,
  SessionGrants,
  SupervisedSession,
  withCatchup,
  type CarryoverSource,
  type PermissionProfile,
} from '@chorus/orchestrator'
import {
  AGENT_IDS,
  isAgentId,
  newConversationId,
  newHandoffId,
  type AgentId,
  type Logger,
} from '@chorus/shared'
import type { ProjectRecord, RuntimeHost, RuntimeNotifications } from './ports.js'

const DATABASE_FILE = 'chorus.v2.db'

const JOINING_CATCHUP_CHARS = 60_000

const HANDOFF_CONTEXT_CHARS = 20_000

const KEEP_IN_ENGLISH = [
  'Keep identifiers, file names and paths exactly as written, in their own',
  'script. Do not translate or transliterate them.',
  '',
  'Keep the technical vocabulary in English too, inside otherwise translated',
  'sentences — event, status, variable, commit, branch, props, hook, endpoint,',
  'cache, migration, and the names of tools, libraries, formats and APIs. A term',
  'translated is one the reader has to translate back before they can search for',
  'it, or match it against the code in front of them.',
]

export const DEFAULT_STYLE_INSTRUCTION = [
  'Write every reply as paired paragraphs: one paragraph in English, then the same',
  'paragraph in Modern Standard Arabic immediately under it, then the next point',
  'and the same again. The unit is the paragraph, never the whole answer — do not',
  'write the entire reply in one language and then repeat it in the other.',
  '',
  'The Arabic is a full restatement rather than a summary. It says the same thing,',
  'at the same length, and leaves nothing out.',
  '',
  ...KEEP_IN_ENGLISH,
  '',
  'Inside the Arabic paragraph, carry a further share of the sentence in English,',
  'and put that share on verbs and nouns — appending, passing, field, value,',
  'projects, agents. Not on connectives: "otherwise", "which means" and "once" read',
  'as an English sentence interrupted by Arabic, while an English noun inside an',
  'Arabic clause reads as how a developer actually speaks.',
  '',
  'Definite articles stay Arabic and attached — الـ Settings, never "the Settings".',
  'Do not attach an Arabic prefix to an English word in any other position.',
  '',
  'Open every Arabic paragraph with an Arabic word. Direction is decided per block',
  'from its own first strong character, so a paragraph that begins with an',
  'identifier or a code span is laid out left to right however much Arabic follows',
  'it, and nothing later in the paragraph can undo that.',
  '',
  'A status block, a table, or anything else whose value is that it can be scanned',
  'stays in English and is not doubled. Doubling it produces a second essay where a',
  'footer was wanted.',
  '',
  'Questions follow the same rule as a reply, and they matter most, being blocking',
  'and dense. Write the question text in English, then the same text in Arabic as a',
  'separate paragraph under it.',
  '',
  'Option labels and headers stay English — a label is a few words wide and a header',
  'a dozen characters, so two languages truncate both. An option description carries',
  'both languages, and they never share a paragraph: the English sentence first, the',
  'Arabic sentence after it as its own paragraph. Do not mix the two inside one',
  'sentence anywhere in a question card. That card does not resolve direction per',
  'run, so a mixed sentence is laid out by whichever script opened it and the rest',
  'reads backwards.',
].join('\n')

export function goPrompt(): string {
  return [
    'Go ahead with what you just proposed.',
    '',
    'You have already described it, so do not restate it and do not re-plan it.',
    'Start with the doing.',
    '',
    'Work to the end of what you proposed. Stop before the end only if a decision',
    'is genuinely blocking — and then ask that one question and nothing else.',
    '',
    'If you were asking me something rather than offering to act, answer the',
    'question instead. If you are waiting on a decision only I can make, say which',
    'one. Do not guess at what I would have chosen.',
  ].join('\n')
}

export interface StartConversationOptions {
  readonly projectId: string
  readonly title?: string
  readonly profileId?: string
  readonly continueFrom?: string
  readonly agents?: readonly AgentId[]
}

export interface SendResult {
  readonly targets: readonly AgentId[]
}

export interface ConversationHandle {
  readonly conversationId: string
  readonly participants: readonly AgentId[]
  readonly profileId: string
  readonly projectId: string
  readonly cwd: string
  readonly title: string
}

interface Participant {
  readonly agentId: AgentId
  readonly service: ConversationService
  readonly session: SupervisedSession
  seenSeq: number
  seedContext?: string
  catchupBudget?: number
  lastReply?: { readonly eventId: string; readonly text: string }
  dispatchEpoch?: number
}

interface ActiveConversation {
  readonly conversationId: string
  readonly participants: Map<AgentId, Participant>
  readonly grants: SessionGrants
  profile: PermissionProfile
  readonly projectId: string
  readonly cwd: string
  title: string
  lastAddressed: AgentId | undefined
  lastSeenSeq: number
  planning: boolean
  styleOn: boolean
  handoffEpoch: number
}

function readOnlyProfiling(): boolean {
  return process.env['CHORUS_PROFILE_READONLY'] === '1'
}

function folderName(cwd: string): string {
  const name = basename(cwd)
  return name === '' ? cwd : name
}

function openOrRecover(
  path: string,
  userDataPath: string
): { db: SqliteHandle; store: EventStore; recovered: string | null } {
  const stem = basename(path).replace(/\.db$/, '')

  const snapshot = (db: SqliteHandle, from: number): string => {
    const destination = join(userDataPath, `${stem}.pre-v${String(from)}.db`)
    if (existsSync(destination)) rmSync(destination)
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    return destination
  }

  let db: SqliteHandle
  let recovered: string | null = null
  try {
    db = openSqlite({ path })
  } catch (error) {
    if (!existsSync(path)) throw error
    const moved = join(userDataPath, `${stem}.unreadable-${String(Date.now())}.db`)
    renameSync(path, moved)
    db = openSqlite({ path })
    recovered = moved
  }

  return { db, store: EventStore.open(db, (from) => snapshot(db, from)).store, recovered }
}

export class CollaborationRuntime {
  private readonly active = new Map<string, ActiveConversation>()
  private readonly limits = new Map<AgentId, readonly UsageWindow[]>()
  readonly ledger: CommandLedger
  private notifications: RuntimeNotifications

  private constructor(
    private readonly db: SqliteHandle,
    readonly store: EventStore,
    private readonly host: RuntimeHost,
    readonly log: Logger
  ) {
    this.notifications = host.notifications ?? {}
    this.ledger = new CommandLedger(db)
    this.store.subscribe((events) => {
      this.followHandoffs(events)
    })
  }

  static open(host: RuntimeHost, log: Logger): CollaborationRuntime {
    const path = join(host.dataPath, DATABASE_FILE)
    const { db, store, recovered } = openOrRecover(path, host.dataPath)
    if (recovered !== null) log.warn('database was unreadable and was moved aside', { recovered })

    const { closed } = readOnlyProfiling() ? { closed: 0 } : store.reconcileOrphanedSessions()
    if (closed > 0) log.warn('closed sessions orphaned by a crash', { closed })
    log.info('runtime ready', { events: store.lastSeq() })

    return new CollaborationRuntime(db, store, host, log)
  }

  private newGrants(): SessionGrants {
    return new SessionGrants({
      keys: this.host.grants.read(),
      onRemember: (keys) => {
        this.host.grants.write(keys)
        this.log.info('remembered a permission permanently', { total: keys.length })
      },
    })
  }

  onLimitsReported(listener: (push: { agentId: AgentId; windows: readonly UsageWindow[] }) => void): void {
    this.notifications = { ...this.notifications, onLimits: listener }
  }

  onContextUsageReported(listener: NonNullable<RuntimeNotifications['onContextUsage']>): void {
    this.notifications = { ...this.notifications, onContextUsage: listener }
  }

  onTasksReported(listener: NonNullable<RuntimeNotifications['onTasks']>): void {
    this.notifications = { ...this.notifications, onTasks: listener }
  }

  onActivityReported(listener: NonNullable<RuntimeNotifications['onActivity']>): void {
    this.notifications = { ...this.notifications, onActivity: listener }
  }

  onConversationsChanged(listener: () => void): void {
    this.notifications = { ...this.notifications, onConversationsChanged: listener }
  }

  knownLimits(): { agentId: AgentId; windows: readonly UsageWindow[] }[] {
    return [...this.limits].map(([agentId, windows]) => ({ agentId, windows: [...windows] }))
  }

  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  availableAgents(): AgentId[] {
    return [...this.host.adapters.keys()]
  }

  availableProfiles(): { id: string; name: string; summary: string }[] {
    return PROFILES.map(({ id, name, summary }) => ({ id, name, summary }))
  }

  sessionGrants(conversationId: string): { key: string; describe: string }[] {
    const first = [...this.require(conversationId).participants.values()][0]
    return first?.service.sessionGrants() ?? []
  }

  async startConversationIn(options: {
    readonly cwd: string
    readonly title?: string
    readonly profileId?: string
    readonly agents?: readonly AgentId[]
  }): Promise<ConversationHandle> {
    const project = this.host.projects.adopt(
      options.cwd.trim() === '' ? homedir() : options.cwd.trim()
    )

    const profileId = options.profileId ?? project.profileId ?? undefined

    return this.startConversation({
      projectId: project.id,
      ...(options.agents === undefined ? {} : { agents: options.agents }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(profileId === undefined ? {} : { profileId }),
    })
  }

  async startConversation(options: StartConversationOptions): Promise<ConversationHandle> {
    const agents = options.agents ?? [...AGENT_IDS]
    if (agents.length === 0) throw new Error('A conversation needs at least one agent')

    const cwd = this.host.projects.resolveAgentCwd(options.projectId)

    if (readOnlyProfiling()) {
      throw new Error('A conversation cannot be started: CHORUS_PROFILE_READONLY is set')
    }

    const carryover =
      options.continueFrom === undefined
        ? null
        : composeCarryover(this.carriedChain(options.continueFrom))

    const conversationId = newConversationId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'conversation.created',
        ...(carryover === null || options.continueFrom === undefined
          ? {}
          : { continuedFrom: options.continueFrom }),
        projectId: options.projectId,
        title: options.title ?? folderName(cwd),
      },
    })

    if (carryover !== null) {
      this.store.append({
        conversationId,
        actor: 'system',
        payload: {
          type: 'notice.raised',
          level: 'info',
          source: 'system',
          code: 'contextCarried',
          text: 'Continued from the previous conversation.',
          detail: null,
        },
      })
    }

    const profile = profileById(options.profileId ?? '')

    const grants = this.newGrants()

    const styleOn = this.host.settings.styleOnByDefault()

    const started = await Promise.allSettled(
      agents.map((agentId) =>
        this.startParticipant(
          agentId,
          conversationId,
          (resuming) =>
            this.sessionOptsFor(
              { conversationId, cwd, profile, styleOn, projectId: options.projectId },
              agentId,
              resuming
            ),
          profile,
          grants
        )
      )
    )

    const conversation: ActiveConversation = {
      conversationId,
      participants: new Map(),
      grants,
      profile,
      projectId: options.projectId,
      cwd,
      title: options.title ?? folderName(cwd),
      lastAddressed: undefined,
      handoffEpoch: 0,
      lastSeenSeq: this.store.lastSeq(),
      planning: false,
      styleOn,
    }
    const failures: string[] = []

    for (const outcome of started) {
      if (outcome.status === 'fulfilled') {
        conversation.participants.set(outcome.value.agentId, outcome.value)
      } else {
        failures.push(
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        )
      }
    }

    if (conversation.participants.size === 0) {
      throw new Error(failures.join('; ') || 'No agent could be started')
    }

    if (carryover !== null) {
      for (const participant of conversation.participants.values()) {
        participant.seedContext = carryover
      }
    }

    for (const message of failures) {
      this.log.error('an agent could not be started', undefined, { conversationId, message })
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message, recoverable: false },
      })
    }

    this.log.info('conversation started', {
      conversationId,
      agents: [...conversation.participants.keys()].join(','),
      profile: profile.id,
    })
    this.active.set(conversationId, conversation)
    this.notifications.onConversationsChanged?.()
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: profile.id,
      projectId: options.projectId,
      cwd,
      title: conversation.title,
    }
  }

  async send(conversationId: string, text: string, intent?: 'go'): Promise<SendResult> {
    const conversation = this.require(conversationId)
    const live = [...conversation.participants.keys()]
    const liveInRoutingOrder: AgentId[] =
      conversation.lastAddressed === undefined && live.includes('claude')
        ? ['claude', ...live.filter((id) => id !== 'claude')]
        : live
    const route = parseMentions(text, {
      participants: [...liveInRoutingOrder, ...AGENT_IDS.filter((id) => !live.includes(id))],
      lastAddressed: conversation.lastAddressed,
    })

    if (route.targets.length === 0) throw new Error('No agent is available in this conversation')

    const stored = this.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text },
    })
    if (stored === null) throw new Error('The runtime is shutting down')
    conversation.lastAddressed = route.targets.at(-1)
    conversation.handoffEpoch += 1

    this.log.info('message accepted', { conversationId, targets: route.targets.join(',') })

    await this.ensureSeated(conversation, route.targets)

    const roster = [...conversation.participants.keys()]

    await Promise.all(
      route.targets
        .map((agentId) => conversation.participants.get(agentId))
        .filter((p) => p !== undefined)
        .map(async (p) => {
          const missed = this.store
            .read(conversationId, { afterSeq: p.seenSeq })
            .filter((e) => e.seq < stored.seq)

          const body = intent === 'go' ? goPrompt() : route.text
          const seeded = p.seedContext === undefined ? body : `${p.seedContext}\n\n${body}`
          delete p.seedContext
          p.dispatchEpoch = conversation.handoffEpoch

          await p.service.deliver(
            withCatchup(
              {
                recipient: p.agentId,
                participants: roster,
                events: missed,
                ...(p.catchupBudget === undefined ? {} : { maxTotalChars: p.catchupBudget }),
              },
              seeded
            )
          )
          p.seenSeq = stored.seq
          delete p.catchupBudget
        })
    )
    this.log.info('message delivered', { conversationId, targets: route.targets.join(',') })
    return { targets: route.targets }
  }

  private followHandoffs(events: readonly StoredEvent[]): void {
    for (const event of events) {
      const from = event.actor
      if (!isAgentId(from)) continue
      const conversation = this.active.get(event.conversationId)
      const participant = conversation?.participants.get(from)
      if (conversation === undefined || participant === undefined) continue
      const { payload } = event
      if (payload.type === 'turn.started') {
        delete participant.lastReply
      } else if (payload.type === 'agent.message.completed') {
        participant.lastReply = { eventId: event.id, text: payload.text }
      } else if (payload.type === 'turn.completed') {
        const reply = participant.lastReply
        delete participant.lastReply
        if (reply === undefined || payload.status !== 'completed') continue
        if (participant.dispatchEpoch !== conversation.handoffEpoch) continue
        queueMicrotask(() => {
          void this.handOffOnward(conversation, from, reply)
        })
      }
    }
  }

  private async handOffOnward(
    conversation: ActiveConversation,
    from: AgentId,
    reply: { readonly eventId: string; readonly text: string }
  ): Promise<void> {
    const { conversationId } = conversation
    const handoff = findReplyHandoff(reply.text, from, AGENT_IDS)
    if (handoff === null) return

    const epoch = conversation.handoffEpoch
    try {
      await this.ensureSeated(conversation, [handoff.to])
      const target = conversation.participants.get(handoff.to)
      if (target === undefined || conversation.handoffEpoch !== epoch) return
      if (this.active.get(conversationId) !== conversation) return

      const stored = this.store.append({
        conversationId,
        actor: from,
        payload: {
          type: 'handoff.created',
          handoffId: newHandoffId(),
          from,
          to: handoff.to,
          sourceEventIds: [reply.eventId],
          brief: handoff.prompt,
        },
      })
      if (stored === null) return
      conversation.lastAddressed = handoff.to
      target.dispatchEpoch = epoch

      const missed = this.store
        .read(conversationId, { afterSeq: target.seenSeq })
        .filter((e) => e.seq < stored.seq && e.id !== reply.eventId)
      const cut = handoff.above.length > HANDOFF_CONTEXT_CHARS
      const above = cut ? handoff.above.slice(-HANDOFF_CONTEXT_CHARS) : handoff.above
      const note = cut
        ? `(only the last ${String(HANDOFF_CONTEXT_CHARS)} characters of it are shown)\n`
        : ''
      const body =
        above === ''
          ? handoff.prompt
          : `${from}'s reply before calling you:\n${note}${above}\n\n${from} asks you:\n${handoff.prompt}`
      const seeded = target.seedContext === undefined ? body : `${target.seedContext}\n\n${body}`
      delete target.seedContext
      await target.service.deliver(
        withCatchup(
          {
            recipient: handoff.to,
            participants: [...conversation.participants.keys()],
            events: missed,
            ...(target.catchupBudget === undefined ? {} : { maxTotalChars: target.catchupBudget }),
          },
          seeded,
          from
        )
      )
      target.seenSeq = stored.seq
      delete target.catchupBudget
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error('a hand-off could not be delivered', undefined, {
        conversationId,
        from,
        to: handoff.to,
        message,
      })
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message: `${handoff.to}: ${message}`, recoverable: true },
      })
    }
  }

  async closeConversation(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    this.active.delete(conversationId)
    this.notifications.onConversationsChanged?.()

    await Promise.all([...conversation.participants.values()].map((p) => p.service.close()))
    this.log.info('conversation closed', {
      conversationId,
      remaining: this.active.size,
    })
  }

  private carriedChain(from: string): CarryoverSource[] {
    const chain: CarryoverSource[] = []
    const seen = new Set<string>()
    let id: string | undefined = from

    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const events = this.store.read(id)
      if (events.length === 0) break

      const created = events.find((event) => event.payload.type === 'conversation.created')
      const meta = created?.payload.type === 'conversation.created' ? created.payload : undefined
      const renamed = events.filter((event) => event.payload.type === 'conversation.renamed').at(-1)
      const title =
        renamed?.payload.type === 'conversation.renamed'
          ? renamed.payload.title
          : (meta?.title ?? '')

      chain.unshift({ title, events })
      id = meta?.continuedFrom
    }

    return chain
  }

  private async ensureSeated(
    conversation: ActiveConversation,
    targets: readonly AgentId[]
  ): Promise<void> {
    for (const agentId of targets) {
      if (conversation.participants.has(agentId)) continue
      try {
        await this.addParticipant(conversation.conversationId, agentId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log.error('an addressed agent could not be started', undefined, {
          conversationId: conversation.conversationId,
          agentId,
          message,
        })
        this.store.append({
          conversationId: conversation.conversationId,
          actor: 'system',
          payload: { type: 'error.raised', message: `${agentId}: ${message}`, recoverable: true },
        })
      }
    }
  }

  async addParticipant(conversationId: string, agentId: AgentId): Promise<{ agentId: AgentId }> {
    const conversation = this.require(conversationId)
    if (conversation.participants.has(agentId)) return { agentId }

    const participant = await this.startParticipant(
      agentId,
      conversationId,
      (resuming) => this.sessionOptsFor(conversation, agentId, resuming),
      conversation.profile,
      conversation.grants
    )
    participant.seenSeq = 0
    participant.catchupBudget = JOINING_CATCHUP_CHARS
    conversation.participants.set(agentId, participant)
    this.log.info('agent joined', { conversationId, agentId })
    return { agentId }
  }

  private sessionOptsFor(
    where: {
      readonly cwd: string
      readonly profile: PermissionProfile
      readonly styleOn?: boolean
      readonly conversationId?: string
      readonly projectId?: string
    },
    agentId: AgentId,
    resuming = false
  ): SessionOpts {
    const project: ProjectRecord | null =
      where.projectId === undefined ? null : this.host.projects.get(where.projectId)
    const editorPlace =
      project === null ? undefined : { host: project.host, root: project.canonicalRoot }
    const preferred = resuming ? '' : this.host.settings.modelFor(agentId)
    const instructions = [
      where.styleOn === true ? DEFAULT_STYLE_INSTRUCTION : '',
      where.styleOn === undefined ? '' : callRule(AGENT_IDS),
    ]
      .filter((part) => part !== '')
      .join('\n\n')
    const { conversationId } = where
    const transcript: SessionOpts['transcript'] =
      conversationId === undefined
        ? undefined
        : (request) => composeHistory(this.store.read(conversationId), request)
    return {
      cwd: where.cwd,
      ...(preferred === '' ? {} : { model: preferred }),
      ...(instructions === '' ? {} : { instructions }),
      ...(transcript === undefined ? {} : { transcript }),
      ...(editorPlace === undefined ? {} : { editorPlace }),
      sandbox:
        where.profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [where.cwd], networkAccess: false },
    }
  }

  private async startParticipant(
    agentId: AgentId,
    conversationId: string,
    sessionOpts: (resuming: boolean) => SessionOpts,
    profile: PermissionProfile,
    grants: SessionGrants,
    resumeFrom?: string,
    reopening = false
  ): Promise<Participant> {
    const adapter = this.host.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    if (readOnlyProfiling()) {
      throw new Error(`${agentId} cannot start: CHORUS_PROFILE_READONLY is set`)
    }

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
    }

    const opened =
      resumeFrom === undefined
        ? (async () => {
            const opts = sessionOpts(false)
            return { session: await SupervisedSession.start(adapter, opts), opts }
          })()
        : (async () => {
            const resumeOpts = sessionOpts(true)
            try {
              return {
                session: await SupervisedSession.resume(adapter, resumeFrom, resumeOpts),
                opts: resumeOpts,
              }
            } catch {
              const opts = sessionOpts(false)
              return { session: await SupervisedSession.start(adapter, opts), opts }
            }
          })()
    const { session, opts: usedOpts } = await opened

    const effort = this.host.settings.effortFor(agentId)
    if (effort !== '') {
      await session.setEffort(effort).catch((error: unknown) => {
        this.log.warn('could not apply the preferred effort level', {
          agentId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    }

    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
      onLimits: (windows) => {
        const merged = mergeUsageWindows(this.limits.get(agentId) ?? [], windows)
        this.limits.set(agentId, merged)
        this.notifications.onLimits?.({ agentId, windows: merged })
      },
      onContextUsage: (usage) => {
        this.notifications.onContextUsage?.({ conversationId, agentId, ...usage })
      },
      onTasks: (tasks) => {
        this.notifications.onTasks?.({ conversationId, agentId, tasks: [...tasks] })
      },
      onActivity: (activity) => {
        this.notifications.onActivity?.({ conversationId, agentId, activity })
      },
      onPlanExited: () => {
        const conversation = this.active.get(conversationId)
        if (conversation !== undefined) conversation.planning = false
      },
      preflightApproval: async (request) =>
        (await this.host.preflightApproval?.(request.id)) ?? true,
    })
    await service.attach(session, usedOpts, health, reopening)
    return { agentId, service, session, seenSeq: this.store.lastSeq() }
  }

  async decideApproval(
    conversationId: string,
    agentId: AgentId,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.decideApproval(approvalId, decision)
  }

  async answerUserInput(
    conversationId: string,
    agentId: AgentId,
    userInputId: string,
    response: UserInputResponse
  ): Promise<void> {
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.answerUserInput(userInputId, response)
  }

  async interrupt(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    await Promise.all([...conversation.participants.values()].map((p) => p.service.interrupt()))
  }

  history(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, afterSeq === undefined ? {} : { afterSeq })
  }

  transcriptState(conversationId: string): TranscriptState {
    return this.store.transcriptState(conversationId)
  }

  logPosition(): number {
    return this.store.lastSeq()
  }

  activeConversations(): readonly string[] {
    return [...this.active.keys()]
  }

  async close(): Promise<void> {
    const services = [...this.active.values()].flatMap((c) =>
      [...c.participants.values()].map((p) => p.service)
    )
    await Promise.all(services.map((service) => service.close('shutdown')))
    this.active.clear()
    await Promise.all([...this.host.adapters.values()].map((a) => a.dispose()))
    await Promise.all(services.map((service) => service.drain()))

    const dropped = this.store.droppedWrites()
    if (dropped > 0) this.log.warn('events arrived after the log closed', { dropped })
    this.db.close()
  }

  private require(conversationId: string): ActiveConversation {
    const found = this.active.get(conversationId)
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
}
