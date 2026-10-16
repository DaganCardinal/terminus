import { describe, expect, it } from "vitest"
import type {
  DispatcherMessage,
  NetworkBrief,
  StoredDispatcherMessage,
} from "@terminus/protocol"
import {
  briefBlock,
  conversationMessages,
  conversationTools,
  FakeDispatcherChat,
  toolResultText,
  TOOL_RESULT_LIMIT,
  untrustedBlock,
} from "./dispatcher-conversation"

let seq = 0
const stored = (
  turnId: string,
  position: number,
  message: DispatcherMessage
): StoredDispatcherMessage => ({
  seq: ++seq,
  turnId,
  position,
  at: "2026-10-16T14:02:31.000Z",
  message,
})
const user = (text: string): DispatcherMessage => ({
  kind: "user",
  text,
  afterEventSeq: 0,
})
const reply = (
  text: string,
  toolCalls: { id: string; name: string; arguments: unknown }[] = []
): DispatcherMessage => ({
  kind: "dispatcher",
  text,
  toolCalls,
  model: "@cf/zai-org/glm-5.3",
  provider: "workers-ai",
})
const tool = (callId: string): DispatcherMessage => ({
  kind: "tool",
  callId,
  name: "terminus_station",
  arguments: {},
  result: "{}",
  fetchedAt: "t",
})

describe("conversationMessages", () => {
  it("renders earlier turns in a final form that later turns never change", () => {
    const previous = [
      stored("turn-1", 0, user("Where is the footer?")),
      stored(
        "turn-1",
        1,
        reply("", [{ id: "c1", name: "terminus_station", arguments: {} }])
      ),
      stored("turn-1", 2, tool("c1")),
      stored("turn-1", 3, reply("In review.")),
    ]
    const current = {
      brief: "<network-state>now</network-state>",
      messages: [stored("turn-2", 0, user("Thanks"))],
    }
    const first = conversationMessages({ previous, turn: current })
    expect(first).toEqual([
      {
        role: "user",
        content:
          "[network state as of 2026-10-16T14:02Z omitted]\n\nWhere is the footer?",
      },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "terminus_station", arguments: {} }],
      },
      { role: "tool", callId: "c1", name: "terminus_station", content: "{}" },
      {
        role: "assistant",
        text: "In review.",
        toolCalls: [],
        cacheBreakpoint: true,
      },
      {
        role: "user",
        content: "<network-state>now</network-state>\n\nThanks",
      },
    ])
    // A later round of the same turn only appends.
    const later = conversationMessages({
      previous,
      turn: {
        ...current,
        messages: [
          ...current.messages,
          stored(
            "turn-2",
            1,
            reply("", [{ id: "c2", name: "terminus_station", arguments: {} }])
          ),
          stored("turn-2", 2, tool("c2")),
        ],
        providerStates: { 1: { reasoning: "opaque" } },
      },
    })
    expect(later.slice(0, first.length)).toEqual(first)
    expect(later[first.length]).toMatchObject({
      role: "assistant",
      providerState: { reasoning: "opaque" },
    })
  })

  it("closes a stopped turn and answers its unanswered tool calls", () => {
    const messages = conversationMessages({
      previous: [
        stored("turn-1", 0, user("Look up everything")),
        stored(
          "turn-1",
          1,
          reply("", [{ id: "c1", name: "terminus_station", arguments: {} }])
        ),
        stored("turn-1", 9999, { kind: "stopped" }),
        stored("turn-2", 0, user("Try again")),
        stored("turn-2", 9999, { kind: "error", errorKind: "overloaded" }),
      ],
      turn: { brief: "B", messages: [stored("turn-3", 0, user("Hello"))] },
    })
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "user",
    ])
    expect(messages[2]).toMatchObject({
      callId: "c1",
      content: "[not run: the turn ended first]",
    })
    expect(messages[3]).toMatchObject({
      text: "[The user stopped this turn before I finished answering.]",
    })
    // Only the end of the previous turn is a cache breakpoint.
    expect(messages[5]).toMatchObject({
      text: "[This turn failed: the model was overloaded.]",
      cacheBreakpoint: true,
    })
    expect(messages.filter((m) => m.cacheBreakpoint)).toHaveLength(1)
  })
})

describe("untrusted data", () => {
  it("encloses content in a boundary it cannot contain", () => {
    expect(untrustedBlock("tool-result", { tool: "x" }, "data", "b0")).toBe(
      '<tool-result tool="x" boundary="b0">\ndata\n</tool-result boundary="b0">'
    )
    expect(() => untrustedBlock("t", {}, "has b0 inside", "b0")).toThrow()
  })
  it("caps tool results with a note", () => {
    const text = toolResultText("t", "x".repeat(TOOL_RESULT_LIMIT + 10), "b")
    expect(text).toContain("[truncated: 10 more characters")
  })
  it("declares only Terminus' own function tools, in a fixed order", () => {
    expect(conversationTools.map((t) => t.name)).toEqual([
      "terminus_station",
      "terminus_line",
      "terminus_plan",
      "terminus_activity",
      "terminus_search",
      "terminus_conversation",
      "start_planning",
    ])
    for (const t of conversationTools) {
      expect(t.parameters).toMatchObject({ type: "object" })
      expect(t.parameters).not.toHaveProperty("$schema")
    }
  })
})

describe("FakeDispatcherChat", () => {
  const brief: NetworkBrief = {
    network: { name: "Demo", terminusCommit: "c", asOf: "t" },
    attention: {
      blockedTrains: [],
      openConflicts: [],
      conflictReports: [],
      engineerNotices: [],
      awaitingApproval: [],
      repairsAwaitingApproval: [],
    },
    liveLines: [],
    recentPlans: [
      {
        id: "plan-1",
        goal: "Add a footer",
        status: "ready",
        lineIds: [],
        conversationId: "conv-1",
      },
    ],
    finishedLines: [],
  }
  const ask = (text: string, conversation = "conv-2") =>
    new FakeDispatcherChat().respond({
      system: "",
      tools: [],
      maxOutputTokens: 100,
      cacheKey: conversation,
      messages: [
        { role: "user", content: `${briefBlock(brief, "b1")}\n\n${text}` },
      ],
    })

  it("answers questions from the brief", async () => {
    const answer = await ask("How is it going?")
    expect(answer.toolCalls).toEqual([])
    expect(answer.text).toContain("0 live Lines")
  })
  it("plans goals, revising this conversation's latest reviewable plan", async () => {
    expect((await ask("Add a dark mode toggle")).toolCalls[0]).toMatchObject({
      name: "start_planning",
      arguments: { brief: "Add a dark mode toggle" },
    })
    expect(
      (await ask("Change it to use the system theme", "conv-1")).toolCalls[0]
    ).toMatchObject({ arguments: { revisesPlanId: "plan-1" } })
  })
})
