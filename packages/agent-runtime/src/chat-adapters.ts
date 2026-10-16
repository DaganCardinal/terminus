import { z } from "zod"
import {
  argumentsText,
  argumentsValue,
  CHAT_TIMEOUT_MS,
  ChatModelError,
  ChatResponseError,
  type ChatAdapterDeps,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ChatToolCall,
} from "./chat-model"

async function post(
  deps: ChatAdapterDeps,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await deps.transport(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs: deps.timeoutMs ?? CHAT_TIMEOUT_MS,
  })
  if (!response.ok) throw new ChatModelError(provider, response.status)
  try {
    return await response.json()
  } catch {
    throw new ChatResponseError(provider)
  }
}

function read<T extends z.ZodType>(
  schema: T,
  provider: string,
  value: unknown
): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ChatResponseError(provider)
  return parsed.data
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({
                  name: z.string(),
                  arguments: z.unknown().optional(),
                }),
              })
            )
            .nullable()
            .optional(),
        }),
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
})

/**
 * Workers AI chat completions, the endpoint `GatewayModelProvider` calls.
 * Session affinity routes a conversation's calls to the same prefix cache.
 */
export class WorkersAiChatModel implements ChatModel {
  readonly provider = "workers-ai" as const
  readonly model: string
  readonly reasoning
  readonly #deps: ChatAdapterDeps
  constructor(deps: ChatAdapterDeps) {
    this.#deps = deps
    this.model = deps.config.model
    this.reasoning = deps.config.reasoning
  }

  async respond(request: ChatRequest): Promise<ChatResponse> {
    const { config } = this.#deps
    const body = {
      model: config.apiModel,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((message) =>
          message.role === "user"
            ? { role: "user", content: message.content }
            : message.role === "tool"
              ? {
                  role: "tool",
                  tool_call_id: message.callId,
                  content: message.content,
                }
              : {
                  role: "assistant",
                  content: message.text,
                  ...(message.toolCalls.length
                    ? {
                        tool_calls: message.toolCalls.map((call) => ({
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: argumentsText(call.arguments),
                          },
                        })),
                      }
                    : {}),
                }
        ),
      ],
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      max_completion_tokens: request.maxOutputTokens,
      ...(config.reasoning ? { reasoning_effort: config.reasoning } : {}),
    }
    const parsed = read(
      completionSchema,
      "Workers AI",
      await post(
        this.#deps,
        "Workers AI",
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/chat/completions`,
        {
          authorization: `Bearer ${config.token}`,
          "cf-aig-gateway-id": config.gatewayId,
          "x-session-affinity": request.cacheKey,
        },
        body
      )
    )
    const choice = parsed.choices[0]!
    const toolCalls: ChatToolCall[] = (choice.message.tool_calls ?? []).map(
      (call) => ({
        id: call.id,
        name: call.function.name,
        arguments: argumentsValue(call.function.arguments),
      })
    )
    const reason = choice.finish_reason
    return {
      ...(choice.message.content ? { text: choice.message.content } : {}),
      toolCalls,
      finish:
        reason === "length"
          ? "length"
          : reason === "content_filter"
            ? "refused"
            : toolCalls.length
              ? "tool_calls"
              : "stop",
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        ...(parsed.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              cachedInputTokens:
                parsed.usage.prompt_tokens_details.cached_tokens,
            }
          : {}),
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
    }
  }
}

const anthropicBlockSchema = z
  .object({ type: z.string() })
  .catchall(z.unknown())
const anthropicResponseSchema = z.object({
  content: z.array(anthropicBlockSchema),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().nullable().optional(),
      cache_creation_input_tokens: z.number().nullable().optional(),
    })
    .optional(),
})
type AnthropicBlock = z.infer<typeof anthropicBlockSchema>
/** What an Anthropic reply carries into its turn's later rounds. */
const anthropicStateSchema = z.object({
  content: z.array(anthropicBlockSchema),
})

const ephemeral = { type: "ephemeral" } as const

/**
 * Anthropic Messages through AI Gateway, paid with Unified Billing. The
 * system block and the end of the previous turn carry explicit cache
 * breakpoints; top-level automatic caching covers this turn's tool rounds.
 * Thinking blocks go back unchanged in the same turn's later rounds.
 */
export class AnthropicChatModel implements ChatModel {
  readonly provider = "anthropic" as const
  readonly model: string
  readonly reasoning
  readonly #deps: ChatAdapterDeps
  constructor(deps: ChatAdapterDeps) {
    this.#deps = deps
    this.model = deps.config.model
    this.reasoning = deps.config.reasoning
  }

  async respond(request: ChatRequest): Promise<ChatResponse> {
    const { config } = this.#deps
    const body = {
      model: config.apiModel,
      max_tokens: request.maxOutputTokens,
      cache_control: ephemeral,
      system: [
        { type: "text", text: request.system, cache_control: ephemeral },
      ],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      messages: anthropicMessages(request.messages),
      // Models without reasoning levels (Haiku 4.5) take neither setting.
      ...(config.reasoning
        ? {
            thinking: { type: "adaptive" },
            output_config: { effort: config.reasoning },
          }
        : {}),
    }
    const parsed = read(
      anthropicResponseSchema,
      "Anthropic",
      await post(
        this.#deps,
        "Anthropic",
        `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/anthropic/v1/messages`,
        {
          "cf-aig-authorization": `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
        },
        body
      )
    )
    const text = parsed.content
      .flatMap((block) =>
        block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : []
      )
      .join("")
    const toolCalls: ChatToolCall[] = parsed.content.flatMap((block) =>
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
        ? [{ id: block.id, name: block.name, arguments: block.input ?? {} }]
        : []
    )
    const usage = parsed.usage
    const cached = usage?.cache_read_input_tokens ?? 0
    return {
      ...(text ? { text } : {}),
      toolCalls,
      finish:
        parsed.stop_reason === "refusal"
          ? "refused"
          : parsed.stop_reason === "max_tokens"
            ? "length"
            : toolCalls.length
              ? "tool_calls"
              : "stop",
      usage: {
        inputTokens:
          (usage?.input_tokens ?? 0) +
          cached +
          (usage?.cache_creation_input_tokens ?? 0),
        cachedInputTokens: cached,
        outputTokens: usage?.output_tokens ?? 0,
      },
      providerState: { content: parsed.content },
    }
  }
}

/** Neutral messages as Anthropic turns. Tool results share one user turn. */
export function anthropicMessages(messages: ChatMessage[]) {
  const turns: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = []
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    const last = turns.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  for (const message of messages) {
    let blocks: AnthropicBlock[]
    if (message.role === "user")
      blocks = [{ type: "text", text: message.content }]
    else if (message.role === "tool")
      blocks = [
        {
          type: "tool_result",
          tool_use_id: message.callId,
          content: message.content,
        },
      ]
    else {
      const saved = anthropicStateSchema.safeParse(message.providerState)
      blocks = saved.success
        ? saved.data.content.map((block) => ({ ...block }))
        : [
            ...(message.text ? [{ type: "text", text: message.text }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input:
                typeof call.arguments === "object" && call.arguments !== null
                  ? call.arguments
                  : {},
            })),
          ]
      if (!blocks.length) blocks = [{ type: "text", text: "(no reply)" }]
    }
    if (message.cacheBreakpoint)
      blocks[blocks.length - 1] = {
        ...blocks.at(-1)!,
        cache_control: ephemeral,
      }
    push(message.role === "assistant" ? "assistant" : "user", blocks)
  }
  return turns
}

const openAiItemSchema = z.object({ type: z.string() }).catchall(z.unknown())
const openAiResponseSchema = z.object({
  status: z.string().optional(),
  incomplete_details: z
    .object({ reason: z.string().optional() })
    .nullable()
    .optional(),
  output: z.array(openAiItemSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
})
const openAiStateSchema = z.object({ reasoning: z.array(openAiItemSchema) })

/**
 * OpenAI Responses through AI Gateway, with `store: false`, so D1 holds the
 * only copy of a conversation. Encrypted reasoning items go back in the same
 * turn's later rounds.
 */
export class OpenAiChatModel implements ChatModel {
  readonly provider = "openai" as const
  readonly model: string
  readonly reasoning
  readonly #deps: ChatAdapterDeps
  constructor(deps: ChatAdapterDeps) {
    this.#deps = deps
    this.model = deps.config.model
    this.reasoning = deps.config.reasoning
  }

  async respond(request: ChatRequest): Promise<ChatResponse> {
    const { config } = this.#deps
    const body = {
      model: config.apiModel,
      instructions: request.system,
      input: request.messages.flatMap((message) => {
        if (message.role === "user")
          return [{ role: "user", content: message.content }]
        if (message.role === "tool")
          return [
            {
              type: "function_call_output",
              call_id: message.callId,
              output: message.content,
            },
          ]
        const saved = openAiStateSchema.safeParse(message.providerState)
        return [
          ...(saved.success ? saved.data.reasoning : []),
          ...(message.text
            ? [{ role: "assistant", content: message.text }]
            : []),
          ...message.toolCalls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: argumentsText(call.arguments),
          })),
        ]
      }),
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
      max_output_tokens: request.maxOutputTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: request.cacheKey,
      ...(config.reasoning ? { reasoning: { effort: config.reasoning } } : {}),
    }
    const parsed = read(
      openAiResponseSchema,
      "OpenAI",
      await post(
        this.#deps,
        "OpenAI",
        `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/openai/responses`,
        { "cf-aig-authorization": `Bearer ${config.token}` },
        body
      )
    )
    let text = ""
    let refused = false
    const toolCalls: ChatToolCall[] = []
    const reasoning: z.infer<typeof openAiItemSchema>[] = []
    for (const item of parsed.output) {
      if (item.type === "reasoning") reasoning.push(item)
      else if (item.type === "function_call")
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ""),
          name: String(item.name ?? ""),
          arguments: argumentsValue(item.arguments),
        })
      else if (item.type === "message" && Array.isArray(item.content))
        for (const part of item.content as { type?: string; text?: string }[])
          if (part.type === "output_text") text += part.text ?? ""
          else if (part.type === "refusal") refused = true
    }
    const incomplete = parsed.incomplete_details?.reason
    return {
      ...(text ? { text } : {}),
      toolCalls,
      finish:
        refused || incomplete === "content_filter"
          ? "refused"
          : incomplete === "max_output_tokens"
            ? "length"
            : toolCalls.length
              ? "tool_calls"
              : "stop",
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        ...(parsed.usage?.input_tokens_details?.cached_tokens !== undefined
          ? {
              cachedInputTokens:
                parsed.usage.input_tokens_details.cached_tokens,
            }
          : {}),
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
      ...(reasoning.length ? { providerState: { reasoning } } : {}),
    }
  }
}
