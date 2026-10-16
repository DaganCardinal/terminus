import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { FakeDispatcherChat, ChatModelError } from "@terminus/agent-runtime"
import { seedNetwork, testPorts } from "../../test/fixtures"
import {
  createConversation,
  sendMessage,
  stopTurn,
  type ConversationPorts,
} from "../agents/conversations"
import { ConversationStore } from "../integrations/conversation-store"
import { NetworkStore } from "../integrations/network-store"
import {
  recordRound,
  startTurnPlanning,
  turnErrorKind,
  TurnFailure,
  type TurnPorts,
} from "./conversation-operations"
import type { DispatchPlan } from "@terminus/domain"

async function turn() {
  const network = await seedNetwork(testPorts())
  const conversations = new ConversationStore(env.DB)
  const ports: ConversationPorts = {
    store: new NetworkStore(env.DB),
    conversations,
    startTurn: async () => {},
    stopTurn: async () => {},
    newId: (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`,
    now: () => new Date().toISOString(),
  }
  const conversation = await createConversation(ports, network.id, {
    requestId: crypto.randomUUID(),
  })
  const sent = await sendMessage(ports, network.id, conversation.id, {
    requestId: crypto.randomUUID(),
    text: "Look everything up",
    checkBaseline: true,
  })
  const params = {
    turnId: sent.turnId,
    conversationId: conversation.id,
    networkId: network.id,
  }
  const lookups: string[] = []
  const planned: Parameters<TurnPorts["startPlanning"]>[0][] = []
  const turnPorts: TurnPorts = {
    store: new NetworkStore(env.DB),
    conversations,
    chat: new FakeDispatcherChat(),
    tools: () => ({
      run: async (name, args) => {
        lookups.push(name)
        return JSON.stringify({ name, args })
      },
    }),
    startPlanning: async (input) => {
      planned.push(input)
      return {
        id: input.origin.planId,
        state: { status: "planning" },
      } as DispatchPlan
    },
    now: () => new Date().toISOString(),
  }
  return { ports, turnPorts, params, conversations, lookups, planned }
}

const call = (id: string, name = "terminus_station") => ({
  id,
  name,
  arguments: { stationId: id },
})

describe("conversation turn operations", () => {
  it("runs at most six read tools per round and leaves planning for its own step", async () => {
    const { turnPorts, params, conversations, lookups } = await turn()
    const outcome = await recordRound(
      turnPorts,
      params,
      {
        toolCalls: [
          ...Array.from({ length: 7 }, (_, i) => call(`c${i}`)),
          call("p1", "start_planning"),
          call("p2", "start_planning"),
          call("x", "launch_lines"),
        ],
        finish: "tool_calls",
        usage: { inputTokens: 1234, outputTokens: 1 },
      },
      1,
      false
    )
    expect(lookups).toHaveLength(6)
    expect(outcome).toMatchObject({
      kind: "continue",
      next: 11,
      planning: { id: "p1" },
    })
    const saved = await conversations.turnMessages(params.turnId)
    const results = saved.flatMap(({ message }) =>
      message.kind === "tool" ? [[message.callId, message.result]] : []
    )
    expect(results).toHaveLength(9)
    expect(results.find(([id]) => id === "c6")![1]).toContain("At most 6")
    expect(results.find(([id]) => id === "p2")![1]).toContain("Only one plan")
    expect(results.find(([id]) => id === "x")![1]).toContain("No tool named")
    expect(
      (await conversations.conversation(params.conversationId))!.value
        .lastInputTokens
    ).toBe(1234)
  })

  it("starts planning with the user's message and baseline choice", async () => {
    const { turnPorts, params, conversations, planned } = await turn()
    const started = await startTurnPlanning(
      turnPorts,
      params,
      {
        id: "p1",
        name: "start_planning",
        arguments: JSON.stringify({
          brief: "Plan it",
          relatedStationIds: ["s1"],
        }),
      },
      3
    )
    expect(started).toEqual({ kind: "planned", next: 5 })
    expect(planned[0]).toMatchObject({
      brief: "Plan it",
      checkBaseline: true,
      origin: {
        conversationId: params.conversationId,
        turnId: params.turnId,
        request: {
          userMessage: "Look everything up",
          relatedStationIds: ["s1"],
        },
      },
    })
    const kinds = (await conversations.turnMessages(params.turnId)).map(
      (m) => m.message.kind
    )
    expect(kinds).toEqual(["user", "tool", "plan"])
  })

  it("answers a refused or malformed plan as an ordinary tool reply", async () => {
    const { turnPorts, params } = await turn()
    const { DispatchError } = await import("../agents/dispatcher")
    const refused = await startTurnPlanning(
      {
        ...turnPorts,
        startPlanning: async () => {
          throw new DispatchError(409, "Plan x is still being prepared")
        },
      },
      params,
      { id: "p1", name: "start_planning", arguments: { brief: "Plan" } },
      1
    )
    expect(refused).toEqual({ kind: "refused", next: 2 })
    const malformed = await startTurnPlanning(
      turnPorts,
      params,
      { id: "p2", name: "start_planning", arguments: {} },
      2
    )
    expect(malformed).toEqual({ kind: "refused", next: 3 })
  })

  it("fences a stopped turn's late writes", async () => {
    const { ports, turnPorts, params, conversations } = await turn()
    await stopTurn(
      ports,
      params.networkId,
      params.conversationId,
      params.turnId
    )
    const outcome = await recordRound(
      turnPorts,
      params,
      {
        text: "late",
        toolCalls: [],
        finish: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      1,
      false
    )
    expect(outcome).toEqual({ kind: "fenced" })
    expect(
      (await conversations.turnMessages(params.turnId)).map(
        (m) => m.message.kind
      )
    ).toEqual(["user", "stopped"])
  })

  it("records only the kind of a failure", () => {
    expect(turnErrorKind(new TurnFailure("refused"))).toBe("refused")
    expect(
      turnErrorKind(new Error("Dispatcher turn failed (overloaded)"))
    ).toBe("overloaded")
    expect(turnErrorKind(new ChatModelError("Anthropic", 529))).toBe(
      "overloaded"
    )
    expect(turnErrorKind(new ChatModelError("Anthropic", 401))).toBe(
      "configuration"
    )
    expect(
      turnErrorKind(
        new Error("Configure AI_GATEWAY_ID before running real agents")
      )
    ).toBe("configuration")
    expect(turnErrorKind(new Error("The operation timed out"))).toBe(
      "timed_out"
    )
    expect(turnErrorKind(new Error("anything else"))).toBe("failed")
  })
})
