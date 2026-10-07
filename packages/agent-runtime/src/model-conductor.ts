import {
  junctionReviewInputSchema,
  type JunctionReviewInput,
  crossingReviewInputSchema,
  conductorVerdictSchema,
  type ConductorVerdict,
} from "@terminus/protocol"
import { unmetRequiredChecks } from "@terminus/domain"
import type { Conductor, ReviewInput, CrossingReviewInput } from "./roles"
import type { ModelProvider } from "./model-provider"
import {
  conductorPrompt,
  crossingReviewGuidance,
  junctionReviewGuidance,
} from "./conductor-prompt"

export class ModelConductor implements Conductor {
  readonly model: string
  private readonly provider: ModelProvider
  constructor(model: string, provider: ModelProvider) {
    this.model = model
    this.provider = provider
  }

  async reviewJunction(input: JunctionReviewInput): Promise<ConductorVerdict> {
    input = junctionReviewInputSchema.parse(input)
    return conductorVerdictSchema.parse(
      await this.provider.generateStructured({
        role: "conductor",
        system: conductorPrompt + "\n" + junctionReviewGuidance,
        input,
      })
    )
  }

  async reviewCrossing(input: CrossingReviewInput): Promise<ConductorVerdict> {
    input = crossingReviewInputSchema.parse(input)
    return conductorVerdictSchema.parse(
      await this.provider.generateStructured({
        role: "conductor",
        system: conductorPrompt + "\n" + crossingReviewGuidance,
        input,
      })
    )
  }
  async review(input: ReviewInput): Promise<ConductorVerdict> {
    return (
      precheckedVerdict(input) ??
      conductorVerdictSchema.parse(
        await this.provider.generateStructured({
          role: "conductor",
          system: conductorPrompt,
          input,
        })
      )
    )
  }
}

/** Verdicts that need no model: no review can accept failed checks or a missing diff. */
export function precheckedVerdict(input: ReviewInput): ConductorVerdict | null {
  const missing = unmetRequiredChecks(
    input.proposal.evidence,
    input.manifest.expectedEvidence
  )
  if (missing.length)
    return {
      verdict: "return",
      summary: "Required validation is missing or failed",
      findings: missing.map((check) => `${check.name}: ${check.status}`),
    }
  if (!input.proposal.diff)
    return {
      verdict: "escalate",
      summary: "No actual Git diff is available for review",
      findings: [],
    }
  return null
}
