import { describe, expect, it } from 'vitest'
import {
  ApprovalDecisionSchema,
  ClientMessageSchema,
  CommandEnvelopeSchema,
  CommandResultSchema,
  PROTOCOL_VERSION,
  ReplayBatchSchema,
  UserApprovalDecisionSchema,
  WebviewToHostSchema,
} from './index.js'

const envelope = (command: unknown): unknown => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId: 'req-1',
  engineGeneration: 'gen-1',
  command,
})

describe('collaboration protocol', () => {
  it('accepts a send addressed to a conversation', () => {
    const parsed = CommandEnvelopeSchema.safeParse(
      envelope({ type: 'conversation.send', conversationId: 'conv-1', text: '@claude hello' })
    )
    expect(parsed.success).toBe(true)
  })

  it('carries a foreign protocol version through so it can be answered', () => {
    const parsed = CommandEnvelopeSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION + 1,
      requestId: 'req-1',
      engineGeneration: 'gen-1',
      command: { type: 'conversation.interrupt', conversationId: 'conv-1' },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.protocolVersion : null).toBe(PROTOCOL_VERSION + 1)
  })

  it('refuses an unknown command type', () => {
    const parsed = CommandEnvelopeSchema.safeParse(
      envelope({ type: 'conversation.destroy', conversationId: 'conv-1' })
    )
    expect(parsed.success).toBe(false)
  })

  it('refuses a create naming an agent that does not exist', () => {
    const parsed = CommandEnvelopeSchema.safeParse(
      envelope({
        type: 'conversation.create',
        participants: ['claude', 'gpt-9'],
        profileId: 'read-only',
      })
    )
    expect(parsed.success).toBe(false)
  })

  it('refuses a create that tries to name a project', () => {
    const parsed = CommandEnvelopeSchema.safeParse(
      envelope({
        type: 'conversation.create',
        projectId: '/etc',
        participants: ['claude'],
        profileId: 'read-only',
      })
    )
    expect(parsed.success).toBe(false)
  })

  it('does not let a client declare a prompt timed out', () => {
    const parsed = UserApprovalDecisionSchema.safeParse({ outcome: 'timeout' })
    expect(parsed.success).toBe(false)
  })

  it('leaves timeout reachable for the engine itself', () => {
    const parsed = ApprovalDecisionSchema.safeParse({ outcome: 'timeout' })
    expect(parsed.success).toBe(true)
  })

  it('requires a scope on an allow decision', () => {
    expect(UserApprovalDecisionSchema.safeParse({ outcome: 'allow' }).success).toBe(false)
    expect(UserApprovalDecisionSchema.safeParse({ outcome: 'allow', scope: 'once' }).success).toBe(
      true
    )
    expect(
      UserApprovalDecisionSchema.safeParse({ outcome: 'allow', scope: 'forever' }).success
    ).toBe(false)
  })

  it('requires a message on a deny decision', () => {
    expect(UserApprovalDecisionSchema.safeParse({ outcome: 'deny' }).success).toBe(false)
    expect(UserApprovalDecisionSchema.safeParse({ outcome: 'deny', message: '' }).success).toBe(true)
  })

  it('refuses a result carrying a code the protocol does not define', () => {
    const parsed = CommandResultSchema.safeParse({
      status: 'rejected',
      requestId: 'req-1',
      code: 'because-i-said-so',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a replay batch and keeps its state', () => {
    const parsed = ReplayBatchSchema.safeParse({
      conversationId: 'conv-1',
      throughSeq: 7,
      events: [
        {
          seq: 7,
          id: 'ev-7',
          conversationId: 'conv-1',
          actor: 'user',
          type: 'user.message',
          payload: { type: 'user.message', text: 'hello' },
          createdAt: 1,
          schemaVersion: 1,
        },
      ],
      state: { approvals: [], questions: [], working: [], usageByActor: {} },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a decision from a card', () => {
    const parsed = WebviewToHostSchema.safeParse({
      kind: 'decide',
      agentId: 'claude',
      approvalId: 'ap-1',
      allow: true,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a webview message that names a conversation of its own choosing', () => {
    const parsed = WebviewToHostSchema.safeParse({
      kind: 'decide',
      conversationId: 'somewhere-else',
      agentId: 'claude',
      approvalId: 'ap-1',
      allow: true,
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses an answer with no answers', () => {
    expect(
      WebviewToHostSchema.safeParse({
        kind: 'answer',
        agentId: 'claude',
        userInputId: 'u-1',
        answers: [],
      }).success
    ).toBe(false)
  })

  it('accepts a hello and refuses one with no token', () => {
    expect(ClientMessageSchema.safeParse({ kind: 'hello', protocolVersion: 1, token: 'x' }).success).toBe(
      true
    )
    expect(ClientMessageSchema.safeParse({ kind: 'hello', protocolVersion: 1 }).success).toBe(false)
  })
})
