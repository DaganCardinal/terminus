import {
  decisionQuestionsSchema,
  decisionRunResponseSchema,
  type DecisionAnswer,
  type DecisionQuestion,
} from "@terminus/protocol"
import type { ModelTransport } from "./model-provider"

export interface DecisionRequest {
  role: "engineer"
  /** What the questions are about. Only deterministic domain state. */
  state: unknown
  questions: Record<string, DecisionQuestion>
}

/** Scores fixed answer options. One answer per question, matching its type. */
export interface DecisionModel {
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>
}

/** Calls a Clef decision model through the Workers AI REST endpoint and Gateway. */
export class GatewayDecisionModel implements DecisionModel {
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

  async decide(
    request: DecisionRequest
  ): Promise<Record<string, DecisionAnswer>> {
    const questions = decisionQuestionsSchema.parse(request.questions)
    const response = await this.transport(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/run/${this.config.model}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
          "cf-aig-gateway-id": this.config.gatewayId,
        },
        body: JSON.stringify({
          // The body names the model without its `@cf/cloudflare/` prefix.
          model: this.config.model.split("/").at(-1),
          state: request.state,
          questions,
        }),
        timeoutMs: 30_000,
      }
    )
    if (!response.ok)
      throw new Error(
        `${request.role} decision request failed (${response.status})`
      )
    const { answers } = decisionRunResponseSchema.parse(
      await response.json()
    ).result
    for (const [id, question] of Object.entries(questions)) {
      if (answers[id]?.type !== question.type)
        throw new Error(`${request.role} decision model did not answer ${id}`)
    }
    return answers
  }
}
