import {
  briefBlock,
  buildNetworkBrief,
  ChatModelError,
  conversationMessages,
  conversationPrompt,
  conversationTools,
  newBoundary,
  parseToolArguments,
  toolResultText,
  TURN_MAX_OUTPUT_TOKENS,
  TURN_MAX_TOOL_CALLS,
  type ChatModel,
  type ChatResponse,
  type ChatToolCall,
} from "@terminus/agent-runtime"
import {
  recordTurnUsage,
  turnIsActive,
  type DispatchPlan,
} from "@terminus/domain"
import {
  dispatcherReadTools,
  dispatcherToolArguments,
  errorDetail,
  type DispatcherMessage,
  type DispatcherReadTool,
  type TurnErrorKind,
} from "@terminus/protocol"
import { DispatchError } from "../agents/dispatcher"
import {
  finishTurn,
  turnPlanId,
  type TurnParams,
} from "../agents/conversations"
import type { ConversationPlanOrigin } from "../agents/dispatch-planning"
import type { ConversationStore } from "../integrations/conversation-store"
import { TurnFencedError } from "../integrations/conversation-store"
import type { NetworkStore } from "../integrations/network-store"

export interface TurnPorts {
  store: Pick<NetworkStore, "snapshot">
  conversations: ConversationStore
  chat: ChatModel
  /** A fresh runner per round, so each round reads one snapshot. */
  tools(): { run(name: DispatcherReadTool, args: unknown): Promise<string> }
  startPlanning(input: {
    brief: string
    checkBaseline: boolean
    origin: ConversationPlanOrigin
  }): Promise<DispatchPlan>
  now(): string
}

/** A failed model call, carrying only the kind of failure in its message,
 * so the kind survives the step boundary and nothing else does. */
export class TurnFailure extends Error {
  readonly kind: TurnErrorKind
  constructor(kind: TurnErrorKind) {
    super(`Dispatcher turn failed (${kind})`)
    this.name = "TurnFailure"
    this.kind = kind
  }
}

/** The kind of a turn failure, from the error or from its message. */
export function turnErrorKind(error: unknown): TurnErrorKind {
  if (error instanceof TurnFailure) return error.kind
  const message = error instanceof Error ? error.message : ""
  const named = /^Dispatcher turn failed \((\w+)\)/.exec(message)?.[1]
  if (named) return named as TurnErrorKind
  if (error instanceof ChatModelError)
    return [429, 503, 529].includes(error.status)
      ? "overloaded"
      : [401, 403, 404].includes(error.status)
        ? "configuration"
        : "failed"
  if (
    /^Configure |^Unknown curated model|provider is not enabled/.test(message)
  )
    return "configuration"
  const classes = (errorDetail(error) ?? "").split(/[ |]/)
  if (classes.includes("timeout") || /timed? ?out/i.test(message))
    return "timed_out"
  if (classes.includes("overloaded")) return "overloaded"
  return "failed"
}

async function active(
  ports: Pick<TurnPorts, "conversations">,
  params: TurnParams
): Promise<boolean> {
  const conversation = await ports.conversations.conversation(
    params.conversationId
  )
  return !!conversation && turnIsActive(conversation.value, params.turnId)
}

/** The network brief, built once so every round sees the same state. */
export async function buildTurnBrief(
  ports: Pick<TurnPorts, "store" | "now">,
  params: TurnParams
): Promise<string> {
  const snapshot = await ports.store.snapshot(params.networkId)
  if (!snapshot) throw new Error("Unknown network")
  return briefBlock(buildNetworkBrief(snapshot, ports.now()), newBoundary())
}

/**
 * One model call. Reads the conversation from D1, so it always answers the
 * saved history. Null when the turn was stopped.
 */
export async function respondInTurn(
  ports: Pick<TurnPorts, "conversations" | "chat">,
  params: TurnParams,
  brief: string,
  providerStates: Record<number, unknown>
): Promise<ChatResponse | null> {
  if (!(await active(ports, params))) return null
  const [previous, current] = await Promise.all([
    ports.conversations.history(params.conversationId, params.turnId),
    ports.conversations.turnMessages(params.turnId),
  ])
  try {
    return await ports.chat.respond({
      system: conversationPrompt,
      messages: conversationMessages({
        previous,
        turn: { brief, messages: current, providerStates },
      }),
      tools: conversationTools,
      maxOutputTokens: TURN_MAX_OUTPUT_TOKENS,
      cacheKey: params.conversationId,
    })
  } catch (error) {
    console.error("dispatcher.turn_model_failed", {
      turnId: params.turnId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      detail: errorDetail(error),
    })
    throw new TurnFailure(turnErrorKind(error))
  }
}

export type RoundOutcome =
  | { kind: "fenced" }
  | { kind: "done"; error?: TurnErrorKind }
  | { kind: "continue"; next: number; planning?: ChatToolCall }

/**
 * Saves a reply and answers its read tools. `start_planning` is left for its
 * own step. A closing reply after planning keeps its text only.
 */
export async function recordRound(
  ports: Pick<TurnPorts, "conversations" | "chat" | "tools" | "now">,
  params: TurnParams,
  reply: ChatResponse,
  position: number,
  closing: boolean
): Promise<RoundOutcome> {
  const calls = closing ? [] : reply.toolCalls
  try {
    await ports.conversations.appendTurnMessages(
      params.conversationId,
      params.turnId,
      [
        {
          position,
          message: {
            kind: "dispatcher",
            text: reply.text ?? "",
            toolCalls: calls,
            model: ports.chat.model,
            provider: ports.chat.provider,
            ...(ports.chat.reasoning
              ? { reasoning: ports.chat.reasoning }
              : {}),
          },
        },
      ],
      ports.now()
    )
  } catch (error) {
    if (error instanceof TurnFencedError) return { kind: "fenced" }
    throw error
  }
  await saveUsage(ports, params, reply.usage.inputTokens)
  if (reply.finish === "refused") return { kind: "done", error: "refused" }
  if (!calls.length) return { kind: "done" }
  const runner = ports.tools()
  let planning: ChatToolCall | undefined
  let ran = 0
  const answers = await Promise.all(
    calls.map(async (call) => {
      const answer = (result: string) => ({
        call,
        result: toolResultText(call.name, result, newBoundary()),
      })
      if (call.name === "start_planning") {
        if (!planning) {
          planning = call
          return null
        }
        return answer(
          JSON.stringify({ refused: "Only one plan can start per turn." })
        )
      }
      if (!(dispatcherReadTools as readonly string[]).includes(call.name))
        return answer(JSON.stringify({ error: `No tool named ${call.name}` }))
      if (++ran > TURN_MAX_TOOL_CALLS)
        return answer(
          JSON.stringify({
            refused: `At most ${TURN_MAX_TOOL_CALLS} tool calls run per round; ask again for the rest.`,
          })
        )
      try {
        return answer(
          await runner.run(call.name as DispatcherReadTool, call.arguments)
        )
      } catch (error) {
        console.error("dispatcher.turn_tool_failed", {
          turnId: params.turnId,
          tool: call.name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
        return answer(
          JSON.stringify({ error: "The lookup failed; try again." })
        )
      }
    })
  )
  const saved = answers.flatMap((entry) => (entry ? [entry] : []))
  const at = ports.now()
  try {
    await ports.conversations.appendTurnMessages(
      params.conversationId,
      params.turnId,
      saved.map(({ call, result }, index) => ({
        position: position + 1 + index,
        message: {
          kind: "tool",
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          result,
          fetchedAt: at,
        },
      })),
      at
    )
  } catch (error) {
    if (error instanceof TurnFencedError) return { kind: "fenced" }
    throw error
  }
  return {
    kind: "continue",
    next: position + 1 + saved.length,
    ...(planning ? { planning } : {}),
  }
}

async function saveUsage(
  ports: Pick<TurnPorts, "conversations" | "now">,
  params: TurnParams,
  inputTokens: number
) {
  // Advisory: only the compaction check reads it.
  try {
    const conversation = await ports.conversations.conversation(
      params.conversationId
    )
    if (!conversation) return
    const updated = recordTurnUsage(
      conversation.value,
      params.turnId,
      inputTokens
    )
    if (updated.ok)
      await ports.conversations.save(conversation, updated.value, ports.now())
  } catch {
    console.warn("Dispatcher turn usage was not saved", {
      turnId: params.turnId,
    })
  }
}

/**
 * Runs `start_planning` through the existing planning path. Its tool reply
 * and a `plan` message are saved together. A refusal is an ordinary reply
 * the model can act on.
 */
export async function startTurnPlanning(
  ports: Pick<TurnPorts, "conversations" | "startPlanning" | "now">,
  params: TurnParams,
  call: ChatToolCall,
  position: number
): Promise<{ kind: "fenced" } | { kind: "planned" | "refused"; next: number }> {
  if (!(await active(ports, params))) return { kind: "fenced" }
  const [user] = await ports.conversations.turnMessages(params.turnId)
  if (user?.message.kind !== "user") throw new Error("Turn has no message")
  const parsed = parseToolArguments(
    dispatcherToolArguments.start_planning,
    call.arguments
  )
  let messages: DispatcherMessage[]
  let outcome: "planned" | "refused"
  const reply = (result: unknown): DispatcherMessage => ({
    kind: "tool",
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
    result: toolResultText(call.name, JSON.stringify(result), newBoundary()),
    fetchedAt: ports.now(),
  })
  if (!parsed.ok) {
    outcome = "refused"
    messages = [reply({ refused: parsed.problem })]
  } else {
    const planId = turnPlanId(params.turnId, position)
    try {
      const plan = await ports.startPlanning({
        brief: parsed.value.brief,
        checkBaseline: !!user.message.checkBaseline,
        origin: {
          planId,
          conversationId: params.conversationId,
          turnId: params.turnId,
          request: {
            userMessage: user.message.text,
            relatedStationIds: parsed.value.relatedStationIds ?? [],
          },
          ...(parsed.value.revisesPlanId
            ? { revises: parsed.value.revisesPlanId }
            : {}),
        },
      })
      outcome = "planned"
      messages = [
        reply({
          started: plan.id,
          status: plan.state.status,
          note: "Planning runs for several minutes. The user reviews the plan on its card and launches it there.",
        }),
        {
          kind: "plan",
          planId: plan.id,
          ...(plan.revises ? { revisesPlanId: plan.revises } : {}),
        },
      ]
    } catch (error) {
      if (!(error instanceof DispatchError) || error.status >= 500) throw error
      outcome = "refused"
      messages = [reply({ refused: error.message })]
    }
  }
  try {
    await ports.conversations.appendTurnMessages(
      params.conversationId,
      params.turnId,
      messages.map((message, index) => ({
        position: position + index,
        message,
      })),
      ports.now()
    )
  } catch (error) {
    if (error instanceof TurnFencedError) return { kind: "fenced" }
    throw error
  }
  return { kind: outcome, next: position + messages.length }
}

/** The conversation is idle again, with an error message when it failed. */
export async function endTurnRun(
  ports: Pick<TurnPorts, "conversations" | "now">,
  params: TurnParams,
  error?: TurnErrorKind
): Promise<void> {
  await finishTurn(
    ports,
    params.conversationId,
    params.turnId,
    error ? { kind: "error", errorKind: error } : null
  )
}
