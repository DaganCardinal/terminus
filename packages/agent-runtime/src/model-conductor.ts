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
import { conductorPrompt } from "./conductor-prompt"

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
        system:
          conductorPrompt +
          "\nReview Junction feature convergence using the actual diff, independent evidence, accepted Cars, repair provenance and feature brief. For junction_input assess compatibility of this arrival with accumulated work; for junction_feature require every feature acceptance criterion and contract. Empty diffs may be accepted when history is already included. Return or escalate incompatible work. Never implement, release, or promote work.",
        input,
      })
    )
  }

  async reviewCrossing(input: CrossingReviewInput): Promise<ConductorVerdict> {
    input = crossingReviewInputSchema.parse(input)
    return conductorVerdictSchema.parse(
      await this.provider.generateStructured({
        role: "conductor",
        system:
          conductorPrompt +
          "\nReview a one-way Crossing compatibility handoff. The source Cars were already accepted. Evaluate their combined effect on receiving Cars/contracts and downstream work using the actual merge diff and independent checks. Do not request source implementation revisions. An empty diff explicitly means the source checkpoint is already included and may be accepted with passing checks. Return or escalate incompatible work; no self-implementation.",
        input,
      })
    )
  }
  async review(input: ReviewInput): Promise<ConductorVerdict> {
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
    return conductorVerdictSchema.parse(
      await this.provider.generateStructured({
        role: "conductor",
        system: conductorPrompt,
        input,
      })
    )
  }
}
