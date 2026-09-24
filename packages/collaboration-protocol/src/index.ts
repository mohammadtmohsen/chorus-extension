import type { ApprovalDecision, UserInputResponse } from '@mohammadtmohsen/agent-protocol'
import { ActorSchema, AgentIdSchema } from '@mohammadtmohsen/shared'
import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const ApprovalScopeSchema = z.enum(['once', 'session', 'always'])

const AllowDecision = z.object({
  outcome: z.literal('allow'),
  scope: ApprovalScopeSchema,
  updatedInput: z.record(z.string(), z.unknown()).optional(),
})

const DenyDecision = z.object({
  outcome: z.literal('deny'),
  message: z.string(),
  interrupt: z.boolean().optional(),
})

const CancelDecision = z.object({ outcome: z.literal('cancel') })

const TimeoutDecision = z.object({ outcome: z.literal('timeout') })

export const ApprovalDecisionSchema = z.discriminatedUnion('outcome', [
  AllowDecision,
  DenyDecision,
  CancelDecision,
  TimeoutDecision,
])

export const UserApprovalDecisionSchema = z.discriminatedUnion('outcome', [
  AllowDecision,
  DenyDecision,
  CancelDecision,
])

export type WireApprovalDecision = z.infer<typeof ApprovalDecisionSchema>
export type WireUserApprovalDecision = z.infer<typeof UserApprovalDecisionSchema>

export const UserInputAnswerSchema = z.object({
  questionId: z.string(),
  values: z.array(z.string()),
})

export const UserQuestionResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('answered'), answers: z.array(UserInputAnswerSchema) }),
  z.object({ outcome: z.literal('cancel') }),
])

export type WireUserQuestionResponse = z.infer<typeof UserQuestionResponseSchema>

export const StoredEventSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  conversationId: z.string(),
  actor: ActorSchema,
  type: z.string(),
  payload: z.object({ type: z.string() }).loose(),
  createdAt: z.number().int(),
  schemaVersion: z.number().int(),
})

export type WireStoredEvent = z.infer<typeof StoredEventSchema>

export const TranscriptStateSchema = z.object({
  approvals: z
    .array(
      z.object({
        approvalId: z.string(),
        agentId: z.string(),
        kind: z.string(),
        request: z.unknown(),
        expiresAt: z.number(),
      })
    )
    .readonly(),
  questions: z
    .array(
      z.object({
        userInputId: z.string(),
        eventId: z.string(),
        agentId: z.string(),
        request: z.unknown(),
        expiresAt: z.number(),
      })
    )
    .readonly(),
  working: z.array(z.string()).readonly(),
  usageByActor: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().nullable(),
    })
  ),
})

export const ConversationCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('conversation.create'),
      participants: z.array(AgentIdSchema),
      profileId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('conversation.send'),
      conversationId: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('conversation.interrupt'),
      conversationId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.decide'),
      conversationId: z.string(),
      agentId: AgentIdSchema,
      approvalId: z.string(),
      decision: UserApprovalDecisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('question.answer'),
      conversationId: z.string(),
      agentId: AgentIdSchema,
      userInputId: z.string(),
      response: UserQuestionResponseSchema,
    })
    .strict(),
  /**
   * A provider credential, handed to the engine that needs it.
   *
   * It travels here rather than in a file because the only place it is allowed
   * to rest is VS Code's SecretStorage, which the engine cannot read. The engine
   * holds it in memory for the life of the process; nothing writes it to disk,
   * and it is never logged — the engine's failure path records the command's
   * `type` and never its payload.
   */
  z
    .object({
      type: z.literal('credential.set'),
      agentId: AgentIdSchema,
      key: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('credential.clear'),
      agentId: AgentIdSchema,
    })
    .strict(),
])

export type ConversationCommand = z.infer<typeof ConversationCommandSchema>

export const CommandEnvelopeSchema = z.object({
  protocolVersion: z.number().int(),
  requestId: z.string(),
  engineGeneration: z.string(),
  command: ConversationCommandSchema,
})

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>

export const CommandRejectionCode = z.enum([
  'invalid-message',
  'unsupported-version',
  'engine-generation-mismatch',
  'unauthorised',
  'unknown-conversation',
  'unknown-agent',
  'engine-shutting-down',
  'failed',
])

export type CommandRejectionCode = z.infer<typeof CommandRejectionCode>

export const CommandResultSchema = z.discriminatedUnion('status', [
  /*
   * `conversationId` is optional because not every accepted command is about
   * one. Setting a credential is accepted or it is not; there is no room it
   * happened in, and inventing an empty id to satisfy the shape would make the
   * field mean "a conversation, or nothing" at every call site that reads it.
   */
  z.object({
    status: z.literal('accepted'),
    requestId: z.string(),
    conversationId: z.string().optional(),
  }),
  z.object({
    status: z.literal('duplicate'),
    requestId: z.string(),
    conversationId: z.string().optional(),
  }),
  z.object({
    status: z.literal('uncertain'),
    requestId: z.string(),
    conversationId: z.string().optional(),
  }),
  z.object({
    status: z.literal('rejected'),
    requestId: z.string(),
    code: CommandRejectionCode,
    detail: z.string().optional(),
  }),
])

export type CommandResult = z.infer<typeof CommandResultSchema>

export const ReplayBatchSchema = z.object({
  conversationId: z.string(),
  throughSeq: z.number().int(),
  events: z.array(StoredEventSchema).readonly(),
  state: TranscriptStateSchema,
})

export type ReplayBatch = z.infer<typeof ReplayBatchSchema>

export type UserApprovalDecision = Exclude<ApprovalDecision, { outcome: 'timeout' }>
export type UserQuestionResponse = Exclude<UserInputResponse, { outcome: 'timeout' }>

export function toApprovalDecision(decision: WireUserApprovalDecision): UserApprovalDecision {
  if (decision.outcome === 'cancel') return { outcome: 'cancel' }
  if (decision.outcome === 'deny') {
    return decision.interrupt === undefined
      ? { outcome: 'deny', message: decision.message }
      : { outcome: 'deny', message: decision.message, interrupt: decision.interrupt }
  }
  return decision.updatedInput === undefined
    ? { outcome: 'allow', scope: decision.scope }
    : { outcome: 'allow', scope: decision.scope, updatedInput: decision.updatedInput }
}

export function toUserQuestionResponse(
  response: WireUserQuestionResponse
): UserQuestionResponse {
  if (response.outcome === 'cancel') return { outcome: 'cancel' }
  return { outcome: 'answered', answers: response.answers }
}

export const StatusLineSchema = z.object({
  text: z.string(),
  tone: z.enum(['info', 'warn', 'error']),
})

export type StatusLine = z.infer<typeof StatusLineSchema>

export const HostToWebviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('events'),
    events: z.array(StoredEventSchema).readonly(),
  }),
  z.object({
    kind: z.literal('status'),
    status: StatusLineSchema,
  }),
  z.object({
    kind: z.literal('draft'),
    text: z.string(),
  }),
])

export type HostToWebview = z.infer<typeof HostToWebviewSchema>

/**
 * What the webview may ask the panel to do, and nothing more.
 *
 * **No `conversationId` anywhere in here, deliberately.** The panel knows which
 * conversation its panel is showing and supplies that itself, so a webview
 * message cannot name a different one. Agent and approval ids stay, because
 * those genuinely come from the card the person clicked.
 *
 * Strict, for the reason the command schema is: the two halves ship together,
 * so an unexpected field is version skew rather than something to shrug at.
 */
export const WebviewToHostSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('send'), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('draft'), text: z.string() }).strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  z
    .object({
      kind: z.literal('decide'),
      agentId: AgentIdSchema,
      approvalId: z.string(),
      allow: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('answer'),
      agentId: AgentIdSchema,
      userInputId: z.string(),
      answers: z
        .array(z.object({ questionId: z.string(), values: z.array(z.string()).min(1) }))
        .min(1),
    })
    .strict(),
])

export type WebviewToHost = z.infer<typeof WebviewToHostSchema>

export const RuntimeDescriptorSchema = z.object({
  protocolVersion: z.number().int(),
  engineGeneration: z.string(),
  socketPath: z.string(),
  token: z.string(),
  pid: z.number().int(),
  dataPath: z.string(),
  build: z.string(),
})

export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>

export const ClientMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    protocolVersion: z.number().int(),
    token: z.string(),
  }),
  z.object({
    kind: z.literal('command'),
    envelope: CommandEnvelopeSchema,
  }),
  z.object({
    kind: z.literal('replay'),
    requestId: z.string(),
    conversationId: z.string(),
    afterSeq: z.number().int().optional(),
  }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

export const ServerMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    protocolVersion: z.number().int(),
    engineGeneration: z.string(),
  }),
  z.object({
    kind: z.literal('result'),
    result: CommandResultSchema,
  }),
  z.object({
    kind: z.literal('replay'),
    requestId: z.string(),
    batch: ReplayBatchSchema,
  }),
  z.object({
    kind: z.literal('events'),
    conversationId: z.string(),
    events: z.array(StoredEventSchema),
  }),
  z.object({
    kind: z.literal('rejected'),
    requestId: z.string(),
    code: CommandRejectionCode,
    detail: z.string().optional(),
  }),
])

export type ServerMessage = z.infer<typeof ServerMessageSchema>
