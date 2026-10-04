import { chatCompletionSchema } from "@terminus/protocol"

export interface ModelRequest {
  role: "conductor" | "dispatcher"
  system: string
  input: unknown
}

export interface ModelProvider {
  generateStructured(request: ModelRequest): Promise<unknown>
}

export type ModelTransport = (
  url: string,
  init: {
    method: "POST"
    headers: Record<string, string>
    body: string
    timeoutMs: number
  }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Calls the configured Cloudflare model through the current REST endpoint and Gateway. */
export class GatewayModelProvider implements ModelProvider {
  private readonly config: {
    accountId: string
    gatewayId: string
    token: string
    model: string
  }
  private readonly transport: ModelTransport
  constructor(
    config: {
      accountId: string
      gatewayId: string
      token: string
      model: string
    },
    transport: ModelTransport
  ) {
    this.config = config
    this.transport = transport
  }

  async generateStructured(request: ModelRequest): Promise<unknown> {
    const response = await this.transport(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
          "cf-aig-gateway-id": this.config.gatewayId,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          response_format: { type: "json_object" },
          reasoning_effort: "low",
          max_completion_tokens: 8192,
        }),
        timeoutMs: 120_000,
      }
    )
    if (!response.ok)
      throw new Error(
        `${request.role} model request failed (${response.status})`
      )
    const parsed = chatCompletionSchema.parse(await response.json())
    const choice = parsed.choices[0]!
    if (choice.finish_reason === "length")
      throw new Error(`${request.role} response was truncated`)
    if (!choice.message.content)
      throw new Error(`${request.role} returned no structured output`)
    return JSON.parse(choice.message.content) as unknown
  }
}
