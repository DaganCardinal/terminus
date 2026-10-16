import type { NetworkId } from "./ids"
import { accept, reject, type Transition } from "./transition"

/**
 * One Dispatcher conversation: an operational record of what the user and
 * the Dispatcher said. It never drives Train movement, and the railway
 * lifecycle never reads it.
 */
export interface DispatcherConversation {
  id: string
  networkId: NetworkId
  /** The first user message, shortened. Empty until the first message. */
  title: string
  createdAt: string
  /** At most one turn runs at a time. Every write from a turn checks that
   * it is still the active one, so a stopped turn's late writes are refused. */
  state:
    | { status: "idle" }
    | { status: "responding"; turnId: string; startedAt: string }
  /** The latest model response's input size, for the compaction check. */
  lastInputTokens?: number
}

/** The longest title kept from a first message. */
export const CONVERSATION_TITLE_LENGTH = 80

export function createConversation(input: {
  id: string
  networkId: NetworkId
  createdAt: string
}): DispatcherConversation {
  return { ...input, title: "", state: { status: "idle" } }
}

/** A conversation's title: its first message on one line, shortened at a word. */
export function conversationTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= CONVERSATION_TITLE_LENGTH) return line
  const cut = line.slice(0, CONVERSATION_TITLE_LENGTH - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > CONVERSATION_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Accepts a user message and starts its turn. Refused while a turn runs. */
export function beginTurn(
  conversation: DispatcherConversation,
  turnId: string,
  text: string,
  at: string
): Transition<DispatcherConversation> {
  if (conversation.state.status === "responding")
    return reject(
      "invalid_state",
      "The Dispatcher is still answering; wait or stop it first"
    )
  if (!text.trim()) return reject("invalid_input", "A message needs text")
  return accept(
    {
      ...conversation,
      title: conversation.title || conversationTitle(text),
      state: { status: "responding", turnId, startedAt: at },
    },
    []
  )
}

/** Whether a turn may still write to its conversation. */
export function turnIsActive(
  conversation: DispatcherConversation,
  turnId: string
): boolean {
  return (
    conversation.state.status === "responding" &&
    conversation.state.turnId === turnId
  )
}

/** The turn finished, failed or was stopped; the conversation is idle again. */
export function endTurn(
  conversation: DispatcherConversation,
  turnId: string
): Transition<DispatcherConversation> {
  if (!turnIsActive(conversation, turnId))
    return reject("invalid_state", "That turn is not running")
  return accept({ ...conversation, state: { status: "idle" } }, [])
}

/** Saves a response's input size, for the compaction check. */
export function recordTurnUsage(
  conversation: DispatcherConversation,
  turnId: string,
  inputTokens: number
): Transition<DispatcherConversation> {
  if (!turnIsActive(conversation, turnId))
    return reject("invalid_state", "That turn is not running")
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
    return reject("invalid_input", "Token counts are non-negative integers")
  return accept({ ...conversation, lastInputTokens: inputTokens }, [])
}
