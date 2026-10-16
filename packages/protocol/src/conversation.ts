import { z } from "zod"
import { modelProviderSchema, reasoningLevelSchema } from "./models"

/** The longest user message, the same limit goals have always had. */
export const CONVERSATION_MESSAGE_LIMIT = 4000

/** Why a turn ended without an answer. Only the kind is recorded, never the
 * error's message, which can carry model output or credentials. */
export const turnErrorKindSchema = z.enum([
  "overloaded",
  "configuration",
  "timed_out",
  "round_limit",
  "refused",
  "failed",
])
export type TurnErrorKind = z.infer<typeof turnErrorKindSchema>

export const dispatcherConversationSchema = z.strictObject({
  id: z.string(),
  networkId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  state: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("idle") }),
    z.strictObject({
      status: z.literal("responding"),
      turnId: z.string(),
      startedAt: z.string(),
    }),
  ]),
  lastInputTokens: z.number().int().nonnegative().optional(),
})

/** One tool call a Dispatcher reply asked for. */
export const conversationToolCallSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  arguments: z.unknown(),
})
export type ConversationToolCall = z.infer<typeof conversationToolCallSchema>

/**
 * What a conversation holds. Provider reasoning and provider-specific state
 * never appear here: they live only in the turn that produced them.
 */
export const dispatcherMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    text: z.string().trim().min(1).max(CONVERSATION_MESSAGE_LIMIT),
    checkBaseline: z.boolean().optional(),
    /** The network's latest event when the message was accepted. */
    afterEventSeq: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("dispatcher"),
    text: z.string(),
    toolCalls: z.array(conversationToolCallSchema),
    model: z.string(),
    provider: modelProviderSchema,
    reasoning: reasoningLevelSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
    /** Capped, with a truncation note. */
    result: z.string(),
    fetchedAt: z.string(),
  }),
  z.strictObject({
    kind: z.literal("plan"),
    planId: z.string(),
    revisesPlanId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("stopped") }),
  z.strictObject({ kind: z.literal("error"), errorKind: turnErrorKindSchema }),
])
export type DispatcherMessage = z.infer<typeof dispatcherMessageSchema>

export const storedDispatcherMessageSchema = z.strictObject({
  seq: z.number().int().positive(),
  turnId: z.string(),
  position: z.number().int().nonnegative(),
  at: z.string(),
  message: dispatcherMessageSchema,
})
export type StoredDispatcherMessage = z.infer<
  typeof storedDispatcherMessageSchema
>

export const createConversationRequestSchema = z.strictObject({
  requestId: z.uuid(),
})
export type CreateConversationRequest = z.infer<
  typeof createConversationRequestSchema
>

export const sendConversationMessageRequestSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(CONVERSATION_MESSAGE_LIMIT),
  /** Install dependencies and run project checks before any plan this
   * message starts explores. Only the user sets it, never the model. */
  checkBaseline: z.boolean().optional(),
})
export type SendConversationMessageRequest = z.infer<
  typeof sendConversationMessageRequestSchema
>

export const conversationSummarySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.enum(["idle", "responding"]),
  /** The turn running now, so the user can stop it. */
  turnId: z.string().optional(),
  updatedAt: z.string(),
  planIds: z.array(z.string()),
})
export type ConversationSummary = z.infer<typeof conversationSummarySchema>

export const conversationsResponseSchema = z.strictObject({
  conversations: z.array(conversationSummarySchema),
})
export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>

export const sendConversationMessageResponseSchema = z.strictObject({
  turnId: z.string(),
  message: storedDispatcherMessageSchema,
})
export type SendConversationMessageResponse = z.infer<
  typeof sendConversationMessageResponseSchema
>

export const conversationMessagesResponseSchema = z.strictObject({
  conversation: conversationSummarySchema,
  messages: z.array(storedDispatcherMessageSchema),
  lastSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
export type ConversationMessagesResponse = z.infer<
  typeof conversationMessagesResponseSchema
>

const id = z.string().trim().min(1).max(200)

/**
 * The Dispatcher's tools in a conversation turn. Read tools take only ids
 * and search text; the network always comes from the turn.
 */
export const dispatcherToolArguments = {
  terminus_station: z.strictObject({ stationId: id }),
  terminus_line: z.strictObject({ lineId: id }),
  terminus_plan: z.strictObject({ planId: id }),
  terminus_activity: z.strictObject({
    entityId: id.describe("A Train, Station or plan id."),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  terminus_search: z.strictObject({
    query: z.string().trim().min(2).max(200),
  }),
  terminus_conversation: z.strictObject({
    conversationId: id,
    before: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Return messages before this seq, for the next page."),
  }),
  start_planning: z.strictObject({
    brief: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_MESSAGE_LIMIT)
      .describe(
        "What the planner should achieve, written from everything said so far."
      ),
    relatedStationIds: z.array(id).max(20).optional(),
    revisesPlanId: id
      .optional()
      .describe(
        "A ready or failed plan in this conversation that this plan replaces."
      ),
  }),
} as const
export type DispatcherToolName = keyof typeof dispatcherToolArguments
export type DispatcherToolArguments<T extends DispatcherToolName> = z.infer<
  (typeof dispatcherToolArguments)[T]
>
export const dispatcherReadTools = [
  "terminus_station",
  "terminus_line",
  "terminus_plan",
  "terminus_activity",
  "terminus_search",
  "terminus_conversation",
] as const satisfies readonly DispatcherToolName[]
export type DispatcherReadTool = (typeof dispatcherReadTools)[number]

/**
 * The Dispatcher's view of the network at the start of a turn, sent to the
 * model as compact JSON. Live Lines that need no attention may shrink to a
 * count when the brief runs over budget; tools return their details.
 */
export interface NetworkBrief {
  network: { name: string; terminusCommit: string; asOf: string }
  attention: {
    blockedTrains: {
      trainId: string
      line: string
      stationId?: string
      issues: string[]
    }[]
    openConflicts: { conflictId: string; trainId: string; paths: string[] }[]
    conflictReports: { trainId: string; summary: string }[]
    engineerNotices: { trainId: string; summary: string }[]
    awaitingApproval: { trainId: string; line: string }[]
    repairsAwaitingApproval: { repairId: string; trainId: string }[]
  }
  liveLines: BriefLine[]
  recentPlans: {
    id: string
    goal: string
    status: string
    lineIds: string[]
    conversationId?: string
  }[]
  finishedLines: {
    name: string
    outcome: "integrated" | "abandoned"
    finishedAt: string
    stations: string[]
  }[]
  olderFinishedLines?: number
}

export type BriefLine = (
  | {
      id: string
      name: string
      destination: string
      unloadMode?: string
      train?: {
        id: string
        status: string
        at?: string
        holds: string[]
        cars: number
      }
      stations: {
        id: string
        name: string
        status: string
        where: import("./line-identity").StationWhere
        goal: string
        expectedAreas: string[]
        contracts: string[]
        dependencies: string[]
      }[]
    }
  | {
      id: string
      name: string
      /** Details omitted to keep the brief small; `terminus_line` has them. */
      summary: string
    }
) & {
  /** The number and colour the map shows for the Line while it is live. */
  number: number
  color: (typeof import("./line-identity").LINE_COLOR_NAMES)[number]
}
