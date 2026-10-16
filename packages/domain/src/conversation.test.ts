import { describe, expect, it } from "vitest"
import {
  beginTurn,
  conversationTitle,
  createConversation,
  endTurn,
  recordTurnUsage,
  turnIsActive,
} from "./conversation"
import { expectRejected, unwrap } from "./testing"

const idle = () =>
  createConversation({ id: "c", networkId: "net", createdAt: "t0" })

describe("Dispatcher conversation turns", () => {
  it("runs one turn at a time and titles the conversation from its first message", () => {
    const responding = unwrap(beginTurn(idle(), "turn-1", "Add a footer", "t1"))
    expect(responding.state).toEqual({
      status: "responding",
      turnId: "turn-1",
      startedAt: "t1",
    })
    expect(responding.title).toBe("Add a footer")
    expectRejected(
      beginTurn(responding, "turn-2", "And a header", "t2"),
      "invalid_state"
    )
    const next = unwrap(
      beginTurn(unwrap(endTurn(responding, "turn-1")), "turn-2", "Hi", "t3")
    )
    expect(next.title).toBe("Add a footer")
  })

  it("fences writes to the active turn", () => {
    const responding = unwrap(beginTurn(idle(), "turn-1", "Hello", "t1"))
    expect(turnIsActive(responding, "turn-1")).toBe(true)
    expect(turnIsActive(responding, "turn-0")).toBe(false)
    expectRejected(endTurn(responding, "turn-0"), "invalid_state")
    const ended = unwrap(endTurn(responding, "turn-1"))
    expect(turnIsActive(ended, "turn-1")).toBe(false)
    expectRejected(endTurn(ended, "turn-1"), "invalid_state")
    expectRejected(recordTurnUsage(ended, "turn-1", 10), "invalid_state")
  })

  it("records input tokens only for the active turn and only as counts", () => {
    const responding = unwrap(beginTurn(idle(), "turn-1", "Hello", "t1"))
    expect(
      unwrap(recordTurnUsage(responding, "turn-1", 1200)).lastInputTokens
    ).toBe(1200)
    expectRejected(recordTurnUsage(responding, "turn-1", -1), "invalid_input")
  })

  it("refuses an empty message", () => {
    expectRejected(beginTurn(idle(), "turn-1", "   ", "t1"), "invalid_input")
  })

  it("shortens long titles at a word and keeps them on one line", () => {
    expect(conversationTitle("Fix\nthe   footer")).toBe("Fix the footer")
    const title = conversationTitle(`${"word ".repeat(40)}end`)
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith("word…")).toBe(true)
  })
})
