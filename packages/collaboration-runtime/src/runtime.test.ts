import { describe, expect, it } from 'vitest'
import type { AgentId } from '@chorus/shared'
import { Logger, newApprovalId } from '@chorus/shared'
import { FakeAdapter } from '@chorus/orchestrator'
import { CollaborationRuntime } from './runtime.js'
import { makeTestHost, type TestHost } from './testing/host.js'

const CWD = '/tmp/chorus-m0-project'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(check: () => boolean, ticks = 200): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    if (check()) return
    await tick()
  }
}

interface Harness {
  readonly runtime: CollaborationRuntime
  readonly adapters: Map<AgentId, FakeAdapter>
  readonly testHost: TestHost
}

function setup(agents: readonly AgentId[] = ['claude', 'codex']): Harness {
  const adapters = new Map<AgentId, FakeAdapter>(
    agents.map((id) => [id, new FakeAdapter({ id })])
  )
  const testHost = makeTestHost({ adapters })
  const runtime = CollaborationRuntime.open(testHost.host, new Logger({ minLevel: 'error' }))
  return { runtime, adapters, testHost }
}

function sessionFor(harness: Harness, agentId: AgentId) {
  const session = harness.adapters.get(agentId)?.sessions[0]
  if (session === undefined) throw new Error(`no session for "${agentId}"`)
  return session
}

describe('Milestone 0 — headless collaboration', () => {
  it('logs a user message once and routes it to the addressed agent', async () => {
    const harness = setup()
    const room = await harness.runtime.startConversationIn({ cwd: CWD })

    const result = await harness.runtime.send(room.conversationId, '@claude please review this')

    expect(result.targets).toEqual(['claude'])
    const messages = harness.runtime
      .history(room.conversationId)
      .filter((event) => event.payload.type === 'user.message')
    expect(messages).toHaveLength(1)

    await harness.runtime.close()
  })

  it('follows a completed reply that calls the other agent', async () => {
    const harness = setup()
    const room = await harness.runtime.startConversationIn({ cwd: CWD })
    const session = sessionFor(harness, 'claude')

    await harness.runtime.send(room.conversationId, '@claude do the thing')
    session.emit({ type: 'turn.started', turnRef: 't1' })
    session.emit({
      type: 'message.completed',
      itemRef: 'm1',
      text: 'The implementation is ready.\n@codex review the change',
    })
    session.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })

    await waitFor(() =>
      harness.runtime
        .history(room.conversationId)
        .some((event) => event.payload.type === 'handoff.created')
    )

    const handoffs = harness.runtime
      .history(room.conversationId)
      .filter((event) => event.payload.type === 'handoff.created')
    expect(handoffs).toHaveLength(1)
    const payload = handoffs[0]?.payload
    expect(payload?.type === 'handoff.created' ? payload.to : null).toBe('codex')
    expect(payload?.type === 'handoff.created' ? payload.from : null).toBe('claude')

    await harness.runtime.close()
  })

  it('raises an approval card and routes the decision to the agent that asked', async () => {
    const harness = setup()
    const room = await harness.runtime.startConversationIn({ cwd: CWD })
    const session = sessionFor(harness, 'claude')

    await harness.runtime.send(room.conversationId, '@claude install the dependencies')

    const approvalId = newApprovalId()
    session.emit({
      type: 'approval.requested',
      request: {
        id: approvalId,
        agentId: 'claude',
        kind: 'command',
        expiresAt: Date.now() + 60_000,
        command: ['npm', 'install'],
        cwd: CWD,
        withNetwork: false,
      },
    })

    await waitFor(() => harness.runtime.transcriptState(room.conversationId).approvals.length === 1)
    const state = harness.runtime.transcriptState(room.conversationId)
    expect(state.approvals[0]?.approvalId).toBe(approvalId)
    expect(state.approvals[0]?.agentId).toBe('claude')

    await harness.runtime.decideApproval(room.conversationId, 'claude', approvalId, {
      outcome: 'allow',
      scope: 'once',
    })

    expect(session.decisions).toEqual([
      { id: approvalId, decision: { outcome: 'allow', scope: 'once' } },
    ])

    await harness.runtime.close()
  })

  it('interrupts every agent in the room', async () => {
    const harness = setup()
    const room = await harness.runtime.startConversationIn({ cwd: CWD })

    await harness.runtime.interrupt(room.conversationId)

    expect(sessionFor(harness, 'claude').interruptRequested).toBe(true)
    expect(sessionFor(harness, 'codex').interruptRequested).toBe(true)

    await harness.runtime.close()
  })

  it('keeps history in order and readable after the runtime is closed and reopened', async () => {
    const harness = setup()
    const room = await harness.runtime.startConversationIn({ cwd: CWD })
    await harness.runtime.send(room.conversationId, '@claude hello')

    const before = harness.runtime.history(room.conversationId)
    const seqs = before.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(harness.runtime.logPosition()).toBeGreaterThanOrEqual(seqs.at(-1) ?? 0)

    const types = before.map((event) => event.payload.type)
    await harness.runtime.close()

    const reopened = CollaborationRuntime.open(harness.testHost.host, new Logger({ minLevel: 'error' }))
    const after = reopened.history(room.conversationId)
    expect(after.slice(0, types.length).map((event) => event.payload.type)).toEqual(types)
    expect(after.some((event) => event.payload.type === 'user.message')).toBe(true)

    await reopened.close()
  })
})
