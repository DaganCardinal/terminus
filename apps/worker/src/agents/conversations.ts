import {
  beginTurn,
  createConversation as createConversationRecord,
  endTurn,
} from "@terminus/domain"
import {
  type ConversationMessagesResponse,
  type ConversationSummary,
  type CreateConversationRequest,
  type SendConversationMessageRequest,
  type SendConversationMessageResponse,
} from "@terminus/protocol"
import { DispatchError } from "./dispatcher"
import type { NetworkStore } from "../integrations/network-store"
import { StaleWriteError } from "../integrations/network-store"
import type {
  ConversationStore,
  LoadedConversation,
} from "../integrations/conversation-store"

/** Closing messages (stopped, error) sit after anything a turn writes. */
export const TURN_END_POSITION = 9_999

export interface ConversationPorts {
  store: Pick<NetworkStore, "network" | "lastSeq">
  conversations: ConversationStore
  startTurn(params: TurnParams): Promise<void>
  /** Stops the turn's Workflow; already stopped or missing is fine. */
  stopTurn(turnId: string): Promise<void>
  newId(prefix: string): string
  now(): string
}

export interface TurnParams {
  turnId: string
  conversationId: string
  networkId: string
}

async function owned(
  ports: Pick<ConversationPorts, "conversations">,
  networkId: string,
  conversationId: string
): Promise<LoadedConversation> {
  const conversation = await ports.conversations.conversation(conversationId)
  if (!conversation || conversation.networkId !== networkId)
    throw new DispatchError(404, "Unknown conversation")
  return conversation
}

export async function createConversation(
  ports: ConversationPorts,
  networkId: string,
  request: CreateConversationRequest
): Promise<ConversationSummary> {
  if (!(await ports.store.network(networkId)))
    throw new DispatchError(404, "Unknown network")
  const at = ports.now()
  const created = await ports.conversations.create(
    createConversationRecord({
      id: `conversation-${request.requestId.replaceAll("-", "")}`,
      networkId,
      createdAt: at,
    }),
    request.requestId,
    at
  )
  if (created.networkId !== networkId)
    throw new DispatchError(
      409,
      "Request identity already belongs to another network"
    )
  return ports.conversations.summary(created)
}

export async function listConversations(
  ports: Pick<ConversationPorts, "store" | "conversations">,
  networkId: string
): Promise<ConversationSummary[]> {
  if (!(await ports.store.network(networkId)))
    throw new DispatchError(404, "Unknown network")
  return ports.conversations.list(networkId)
}

export async function readConversation(
  ports: Pick<ConversationPorts, "conversations">,
  networkId: string,
  conversationId: string,
  after: number
): Promise<ConversationMessagesResponse> {
  const conversation = await owned(ports, networkId, conversationId)
  const page = await ports.conversations.messagesAfter(conversationId, after)
  return {
    conversation: await ports.conversations.summary(conversation),
    messages: page.messages,
    lastSeq: page.messages.at(-1)?.seq ?? after,
    hasMore: page.hasMore,
  }
}

/**
 * Accepts a user message and starts its turn. One turn runs at a time; a
 * retried request returns the message it already sent.
 */
export async function sendMessage(
  ports: ConversationPorts,
  networkId: string,
  conversationId: string,
  request: SendConversationMessageRequest
): Promise<SendConversationMessageResponse> {
  const conversation = await owned(ports, networkId, conversationId)
  const sent = await ports.conversations.messageForRequest(request.requestId)
  if (sent) {
    if (
      sent.conversationId !== conversationId ||
      sent.message.kind !== "user" ||
      sent.message.text !== request.text ||
      !!sent.message.checkBaseline !== !!request.checkBaseline
    )
      throw new DispatchError(
        409,
        "Request identity already belongs to a different message"
      )
    // The first attempt may have stopped before its Workflow started.
    if (
      conversation.value.state.status === "responding" &&
      conversation.value.state.turnId === sent.turnId
    )
      await ports.startTurn({ turnId: sent.turnId, conversationId, networkId })
    const { seq, turnId, position, at, message } = sent
    return { turnId, message: { seq, turnId, position, at, message } }
  }
  const turnId = ports.newId("turn")
  const at = ports.now()
  const started = beginTurn(conversation.value, turnId, request.text, at)
  if (!started.ok) throw new DispatchError(409, started.error.message)
  let message
  try {
    message = await ports.conversations.acceptMessage(
      conversation,
      started.value,
      {
        turnId,
        requestId: request.requestId,
        at,
        message: {
          kind: "user",
          text: request.text,
          ...(request.checkBaseline ? { checkBaseline: true } : {}),
          afterEventSeq: await ports.store.lastSeq(networkId),
        },
      }
    )
  } catch (error) {
    if (error instanceof StaleWriteError)
      return sendMessage(ports, networkId, conversationId, request)
    if (String(error).includes("UNIQUE constraint failed"))
      return sendMessage(ports, networkId, conversationId, request)
    throw error
  }
  try {
    await ports.startTurn({ turnId, conversationId, networkId })
  } catch (error) {
    // Without a Workflow the turn would never finish; free the conversation.
    await finishTurn(ports, conversationId, turnId, {
      kind: "error",
      errorKind: "failed",
    }).catch(() => {})
    throw error
  }
  return { turnId, message }
}

/**
 * Saves the stop first, then stops the Workflow. Fencing discards anything
 * the Workflow was still writing. A plan the turn already started keeps
 * running; its own Stop stops it.
 */
export async function stopTurn(
  ports: ConversationPorts,
  networkId: string,
  conversationId: string,
  turnId: string
): Promise<ConversationSummary> {
  await owned(ports, networkId, conversationId)
  const ended = await finishTurn(ports, conversationId, turnId, {
    kind: "stopped",
  })
  if (!ended) throw new DispatchError(409, "That turn is not running")
  await ports.stopTurn(turnId).catch(() => {
    // Fencing already discards the Workflow's writes; it ends on its own.
    console.warn("Dispatcher turn Workflow could not be stopped", { turnId })
  })
  return ports.conversations.summary(
    (await ports.conversations.conversation(conversationId))!
  )
}

/**
 * Returns the conversation to idle, with an optional closing message.
 * False when the turn had already ended.
 */
export async function finishTurn(
  ports: Pick<ConversationPorts, "conversations" | "now">,
  conversationId: string,
  turnId: string,
  closing:
    | { kind: "stopped" }
    | { kind: "error"; errorKind: import("@terminus/protocol").TurnErrorKind }
    | null
): Promise<boolean> {
  for (;;) {
    const conversation = await ports.conversations.conversation(conversationId)
    if (!conversation) return false
    const ended = endTurn(conversation.value, turnId)
    if (!ended.ok) return false
    try {
      await ports.conversations.endTurn(
        conversation,
        ended.value,
        turnId,
        closing ? { position: TURN_END_POSITION, message: closing } : null,
        ports.now()
      )
      return true
    } catch (error) {
      if (!(error instanceof StaleWriteError)) throw error
    }
  }
}

/** A plan id derived from the turn and the call, so a retry finds its plan. */
export function turnPlanId(turnId: string, position: number): string {
  return `dispatch-${turnId.replace(/^turn-/, "")}-${position}`
}
