import { describe, expect, it } from "vitest"
import type { ConversationMessagesResponse } from "@terminus/protocol"
import { mergeConversation } from "./use-conversation"

const conversation = {
  id: "c",
  title: "Hi",
  state: "idle" as const,
  updatedAt: "t",
  planIds: [],
}
const message = (seq: number) => ({
  seq,
  turnId: "turn",
  position: seq,
  at: "t",
  message: { kind: "stopped" as const },
})
const page = (
  seqs: number[],
  lastSeq: number
): ConversationMessagesResponse => ({
  conversation,
  messages: seqs.map(message),
  lastSeq,
  hasMore: false,
})

describe("mergeConversation", () => {
  it("adds only new messages, in seq order, and advances the cursor", () => {
    const start = {
      conversationId: "c",
      conversation: null,
      messages: [],
      lastSeq: 0,
    }
    const once = mergeConversation(start, page([2, 1], 2))
    const twice = mergeConversation(once, page([2, 3], 3))
    expect(twice.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(twice.lastSeq).toBe(3)
    expect(mergeConversation(twice, page([], 3)).lastSeq).toBe(3)
  })
})
