import { describe, expect, it } from "vitest"
import {
  AnthropicChatModel,
  OpenAiChatModel,
  WorkersAiChatModel,
} from "./chat-adapters"
import {
  ChatModelError,
  parseToolArguments,
  type ChatGatewayConfig,
  type ChatMessage,
  type ChatRequest,
} from "./chat-model"
import {
  dispatcherToolArguments,
  type DispatcherMessage,
  type StoredDispatcherMessage,
} from "@terminus/protocol"
import { conversationMessages } from "./dispatcher-conversation"
import type { ModelTransport } from "./model-provider"

function recording(responses: unknown[], status = 200) {
  const requests: {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }[] = []
  const transport: ModelTransport = async (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    })
    const body = responses.shift()
    return { ok: status < 300, status, json: async () => body }
  }
  return { requests, transport }
}

const config = (
  model: string,
  apiModel: string,
  reasoning?: ChatGatewayConfig["reasoning"]
): ChatGatewayConfig => ({
  accountId: "a".repeat(32),
  gatewayId: "gw",
  token: "secret",
  model,
  apiModel,
  ...(reasoning ? { reasoning } : {}),
})

const tool = {
  name: "terminus_station",
  description: "Station",
  parameters: { type: "object" },
}
const request = (messages: ChatMessage[]): ChatRequest => ({
  system: "You are the Dispatcher.",
  messages,
  tools: [tool],
  maxOutputTokens: 1000,
  cacheKey: "conversation-1",
})
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
const history: ChatMessage[] = [
  { role: "user", content: "Earlier question" },
  {
    role: "assistant",
    text: "Earlier answer",
    toolCalls: [],
    cacheBreakpoint: true,
  },
  { role: "user", content: "Where is the footer work?" },
]

describe("WorkersAiChatModel", () => {
  it("sends chat completions with session affinity and reads tool calls", async () => {
    const { requests, transport } = recording([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "terminus_station",
                    arguments: '{"stationId":"s1"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
    ])
    const model = new WorkersAiChatModel({
      config: config("@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.3", "high"),
      transport,
    })
    const reply = await model.respond(request(history))
    expect(reply).toEqual({
      toolCalls: [
        {
          id: "call-1",
          name: "terminus_station",
          arguments: { stationId: "s1" },
        },
      ],
      finish: "tool_calls",
      usage: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 20 },
    })
    const sent = requests[0]!
    expect(sent.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1/chat/completions`
    )
    expect(sent.headers).toMatchObject({
      authorization: "Bearer secret",
      "cf-aig-gateway-id": "gw",
      "x-session-affinity": "conversation-1",
    })
    expect(sent.body).toMatchObject({
      model: "@cf/zai-org/glm-5.3",
      reasoning_effort: "high",
      max_completion_tokens: 1000,
      tools: [{ type: "function", function: { name: "terminus_station" } }],
    })
    expect((sent.body.messages as unknown[])[0]).toEqual({
      role: "system",
      content: "You are the Dispatcher.",
    })

    // The next round sends the call and its result back.
    const next = recording([
      {
        choices: [
          { finish_reason: "stop", message: { content: "In review." } },
        ],
      },
    ])
    const again = new WorkersAiChatModel({
      config: config("@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.3"),
      transport: next.transport,
    })
    expect(
      (
        await again.respond(
          request([
            ...history,
            { role: "assistant", text: "", toolCalls: reply.toolCalls },
            {
              role: "tool",
              callId: "call-1",
              name: "terminus_station",
              content: "{}",
            },
          ])
        )
      ).text
    ).toBe("In review.")
    const messages = next.requests[0]!.body.messages as Record<
      string,
      unknown
    >[]
    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "terminus_station",
            arguments: '{"stationId":"s1"}',
          },
        },
      ],
    })
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "{}",
    })
    expect(next.requests[0]!.body).not.toHaveProperty("reasoning_effort")
  })

  it("reports content filtering as a refusal and errors by status only", async () => {
    const filtered = new WorkersAiChatModel({
      config: config("@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.3"),
      transport: recording([
        {
          choices: [
            { finish_reason: "content_filter", message: { content: null } },
          ],
        },
      ]).transport,
    })
    expect((await filtered.respond(request(history))).finish).toBe("refused")
    const failing = new WorkersAiChatModel({
      config: config("@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.3"),
      transport: recording([{ error: "secret detail" }], 429).transport,
    })
    const error = await failing.respond(request(history)).catch((e) => e)
    expect(error).toBeInstanceOf(ChatModelError)
    expect(error.status).toBe(429)
    expect(error.message).not.toContain("secret")
  })
})

describe("AnthropicChatModel", () => {
  const anthropic = (transport: ModelTransport, reasoning?: "medium") =>
    new AnthropicChatModel({
      config: config(
        "anthropic/claude-sonnet-5-5",
        "claude-sonnet-5-5",
        reasoning
      ),
      transport,
    })

  it("caches the system block and the previous turn, and replays thinking within the turn", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "terminus_station",
        input: { stationId: "s1" },
      },
    ]
    const { requests, transport } = recording([
      {
        content,
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
          output_tokens: 30,
        },
      },
      {
        content: [{ type: "text", text: "It is in review." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 8 },
      },
    ])
    const model = anthropic(transport, "medium")
    const first = await model.respond(request(history))
    expect(first).toMatchObject({
      toolCalls: [
        {
          id: "toolu_1",
          name: "terminus_station",
          arguments: { stationId: "s1" },
        },
      ],
      finish: "tool_calls",
      usage: { inputTokens: 960, cachedInputTokens: 900, outputTokens: 30 },
      providerState: { content },
    })
    const sent = requests[0]!
    expect(sent.url).toBe(
      `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/gw/anthropic/v1/messages`
    )
    expect(sent.headers).toMatchObject({
      "cf-aig-authorization": "Bearer secret",
      "anthropic-version": "2023-06-01",
    })
    expect(sent.headers).not.toHaveProperty("x-api-key")
    expect(sent.body).toMatchObject({
      model: "claude-sonnet-5-5",
      cache_control: { type: "ephemeral" },
      system: [
        {
          type: "text",
          text: "You are the Dispatcher.",
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ name: "terminus_station", input_schema: { type: "object" } }],
    })
    expect(sent.body).not.toHaveProperty("fallbacks")
    expect(sent.body).not.toHaveProperty("tool_choice")
    expect(sent.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Earlier question" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Earlier answer",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Where is the footer work?" }],
      },
    ])

    await model.respond(
      request([
        ...history,
        {
          role: "assistant",
          text: "",
          toolCalls: first.toolCalls,
          providerState: first.providerState,
        },
        {
          role: "tool",
          callId: "toolu_1",
          name: "terminus_station",
          content: "{}",
        },
      ])
    )
    const messages = requests[1]!.body.messages as {
      role: string
      content: unknown[]
    }[]
    // The thinking block goes back unchanged, before its tool call.
    expect(messages.at(-2)).toEqual({ role: "assistant", content })
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }],
    })
  })

  it("stays within Anthropic's four cache breakpoints however long the conversation", async () => {
    for (const turns of [0, 1, 2, 3, 4, 8]) {
      const previous = Array.from({ length: turns }, (_, index) => [
        stored(`turn-${index}`, 0, {
          kind: "user",
          text: `Question ${index}`,
          afterEventSeq: 0,
        }),
        stored(`turn-${index}`, 1, {
          kind: "dispatcher",
          text: `Answer ${index}`,
          toolCalls: [],
          model: "anthropic/claude-sonnet-5-5",
          provider: "anthropic",
        }),
      ]).flat()
      const { requests, transport } = recording([
        { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" },
      ])
      await anthropic(transport).respond(
        request(
          conversationMessages({
            previous,
            turn: {
              brief: "B",
              messages: [
                stored("turn-now", 0, {
                  kind: "user",
                  text: "Now",
                  afterEventSeq: 0,
                }),
              ],
            },
          })
        )
      )
      // The system block, automatic caching, and the end of the previous turn.
      const breakpoints =
        JSON.stringify(requests[0]!.body).match(/"cache_control"/g) ?? []
      expect(breakpoints).toHaveLength(turns ? 3 : 2)
    }
  })

  it("sends no thinking settings to a model without reasoning levels, and reports refusals", async () => {
    const { requests, transport } = recording([
      { content: [], stop_reason: "refusal", usage: {} },
    ])
    const reply = await anthropic(transport).respond(request(history))
    expect(reply.finish).toBe("refused")
    expect(requests[0]!.body).not.toHaveProperty("thinking")
    expect(requests[0]!.body).not.toHaveProperty("output_config")
  })
})

describe("OpenAiChatModel", () => {
  it("keeps nothing at OpenAI and replays encrypted reasoning within the turn", async () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque",
      summary: [],
    }
    const { requests, transport } = recording([
      {
        status: "completed",
        output: [
          reasoning,
          {
            type: "function_call",
            call_id: "call_1",
            name: "terminus_station",
            arguments: '{"stationId":"s1"}',
          },
        ],
        usage: {
          input_tokens: 1000,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 700 },
        },
      },
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Partial" }],
          },
        ],
      },
    ])
    const model = new OpenAiChatModel({
      config: config("openai/gpt-6-luna", "gpt-6-luna", "low"),
      transport,
    })
    const first = await model.respond(request(history))
    expect(first).toMatchObject({
      toolCalls: [
        {
          id: "call_1",
          name: "terminus_station",
          arguments: { stationId: "s1" },
        },
      ],
      finish: "tool_calls",
      usage: { inputTokens: 1000, cachedInputTokens: 700, outputTokens: 40 },
      providerState: { reasoning: [reasoning] },
    })
    expect(requests[0]!.url).toBe(
      `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/gw/openai/responses`
    )
    expect(requests[0]!.body).toMatchObject({
      model: "gpt-6-luna",
      instructions: "You are the Dispatcher.",
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "conversation-1",
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "terminus_station", strict: false }],
    })
    const second = await model.respond(
      request([
        ...history,
        {
          role: "assistant",
          text: "",
          toolCalls: first.toolCalls,
          providerState: first.providerState,
        },
        {
          role: "tool",
          callId: "call_1",
          name: "terminus_station",
          content: "{}",
        },
      ])
    )
    expect(second).toMatchObject({ text: "Partial", finish: "length" })
    expect((requests[1]!.body.input as unknown[]).slice(-3)).toEqual([
      reasoning,
      {
        type: "function_call",
        call_id: "call_1",
        name: "terminus_station",
        arguments: '{"stationId":"s1"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "{}" },
    ])
  })

  it("reports a refusal", async () => {
    const model = new OpenAiChatModel({
      config: config("openai/gpt-6-luna", "gpt-6-luna"),
      transport: recording([
        {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "No." }],
            },
          ],
        },
      ]).transport,
    })
    expect((await model.respond(request(history))).finish).toBe("refused")
  })
})

describe("parseToolArguments", () => {
  const schema = dispatcherToolArguments.terminus_station
  it("accepts JSON sent as text and objects", () => {
    expect(parseToolArguments(schema, '{"stationId":"s1"}')).toEqual({
      ok: true,
      value: { stationId: "s1" },
    })
    expect(parseToolArguments(schema, { stationId: "s1" }).ok).toBe(true)
  })
  it("turns bad calls into a problem the model can correct", () => {
    const bad = parseToolArguments(schema, "{oops")
    expect(bad).toEqual({
      ok: false,
      problem: "The arguments are not valid JSON.",
    })
    const wrong = parseToolArguments(schema, { station: "s1" })
    expect(wrong.ok).toBe(false)
  })
})
