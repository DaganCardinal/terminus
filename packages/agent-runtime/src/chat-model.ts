import type { ModelProviderId, ReasoningLevel } from "@terminus/protocol"
import type { z } from "zod"
import type { ModelTransport } from "./model-provider"

/** A function tool the model may call. Only Terminus' own tools exist here. */
export interface ChatTool {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface ChatToolCall {
  id: string
  name: string
  arguments: unknown
}

/**
 * A provider-neutral message. `providerState` is opaque, and only ever
 * replayed within the turn that produced it.
 */
export type ChatMessage =
  | {
      role: "user"
      content: string
      /** The end of the previous turn: where a stable, cacheable prefix ends. */
      cacheBreakpoint?: boolean
    }
  | {
      role: "assistant"
      text: string
      toolCalls: ChatToolCall[]
      providerState?: unknown
      cacheBreakpoint?: boolean
    }
  | {
      role: "tool"
      callId: string
      name: string
      content: string
      cacheBreakpoint?: boolean
    }

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools: ChatTool[]
  maxOutputTokens: number
  /** The conversation id, so a provider can route for its prompt cache. */
  cacheKey: string
}

export interface ChatResponse {
  text?: string
  toolCalls: ChatToolCall[]
  finish: "stop" | "tool_calls" | "length" | "refused"
  usage: {
    inputTokens: number
    cachedInputTokens?: number
    outputTokens: number
  }
  /** Opaque; replayed only in the same turn's later tool rounds. */
  providerState?: unknown
}

export interface ChatModel {
  readonly model: string
  readonly provider: ModelProviderId
  readonly reasoning?: ReasoningLevel
  respond(request: ChatRequest): Promise<ChatResponse>
}

/** A provider answered with an error status. Only the status is kept. */
export class ChatModelError extends Error {
  readonly status: number
  constructor(provider: string, status: number) {
    super(`${provider} chat request failed (${status})`)
    this.name = "ChatModelError"
    this.status = status
  }
}

/** A provider answered with something this adapter cannot read. */
export class ChatResponseError extends Error {
  constructor(provider: string) {
    super(`${provider} returned an unreadable chat response`)
    this.name = "ChatResponseError"
  }
}

/** Gateway settings every adapter needs. */
export interface ChatGatewayConfig {
  accountId: string
  gatewayId: string
  token: string
  /** The curated model id, recorded on every reply. */
  model: string
  /** The provider's own model name. */
  apiModel: string
  /** Absent when the model has no reasoning control. */
  reasoning?: ReasoningLevel
}

export interface ChatAdapterDeps {
  config: ChatGatewayConfig
  transport: ModelTransport
  /** Each model call's own limit. */
  timeoutMs?: number
}

export const CHAT_TIMEOUT_MS = 5 * 60_000

/**
 * Reads tool arguments leniently, as the plan tools do: JSON sent as text is
 * parsed, then the tool's schema decides. A bad call becomes an ordinary
 * tool reply the model can correct.
 */
export function parseToolArguments<T extends z.ZodType>(
  schema: T,
  raw: unknown
): { ok: true; value: z.infer<T> } | { ok: false; problem: string } {
  let value = raw
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) value = {}
    else
      try {
        value = JSON.parse(text) as unknown
      } catch {
        return { ok: false, problem: "The arguments are not valid JSON." }
      }
  }
  if (value === null || value === undefined) value = {}
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    problem: `The arguments do not match the tool's schema: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ")}`,
  }
}

/** A tool call's arguments as JSON text, for providers that take text. */
export function argumentsText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {})
}

/** Parses a provider's JSON-text arguments, keeping unparseable text as is. */
export function argumentsValue(text: unknown): unknown {
  if (typeof text !== "string") return text ?? {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** The messages after the last user message: this turn's tool rounds. */
export function currentRound(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.findLastIndex((m) => m.role === "user")
  return last === -1 ? messages : messages.slice(last + 1)
}
