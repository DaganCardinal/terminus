import {
  conductorVerdictSchema,
  type ConductorVerdict,
} from "@terminus/protocol"
import { unmetRequiredChecks } from "@terminus/domain"
import type { Conductor, ReviewInput } from "./roles"
import type { ModelProvider } from "./model-provider"
import { conductorPrompt } from "./conductor-prompt"

export class ModelConductor implements Conductor {
  readonly model: string
  private readonly provider: ModelProvider
  constructor(model: string, provider: ModelProvider) {
    this.model = model
    this.provider = provider
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
