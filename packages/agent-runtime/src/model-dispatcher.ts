import type { DispatchProposal, PlanningContext } from "@terminus/domain"
import {
  dispatchProposalSchema,
  type RepositoryContext,
} from "@terminus/protocol"
import { z } from "zod"
import type { ModelProvider } from "./model-provider"
import {
  crossingPlanningGuidance,
  junctionPlanningGuidance,
  dispatcherPrompt,
} from "./dispatcher-prompt"

export interface DispatchPlanningInput {
  goal: string
  repository: RepositoryContext
  network: PlanningContext
}

export interface DispatchPlanner {
  readonly model: string
  plan(input: DispatchPlanningInput): Promise<DispatchProposal>
}

export interface DispatchValidationIssue {
  path: string
  code: string
}

/** Safe field locations and codes only; never put model output or Zod messages in diagnostics. */
export class DispatchProposalError extends Error {
  readonly issues: readonly DispatchValidationIssue[]
  constructor(issues: readonly DispatchValidationIssue[]) {
    super(
      `Dispatcher proposal failed validation after three attempts: ${issues.map((issue) => `${issue.path} (${issue.code})`).join("; ")}`
    )
    this.name = "DispatchProposalError"
    this.issues = issues
  }
}

const fields = new Set([
  "junctions",
  "brief",
  "incoming",
  "outgoing",
  "validation",
  "command",
  "summary",
  "lines",
  "key",
  "name",
  "stations",
  "manifest",
  "goal",
  "scope",
  "expectedAreas",
  "avoidAreas",
  "contracts",
  "kind",
  "change",
  "invariants",
  "dependencies",
  "acceptanceCriteria",
  "expectedEvidence",
  "repositoryChange",
  "description",
  "route",
  "source",
  "stationKey",
  "stationId",
])

function validationIssues(error: z.ZodError): DispatchValidationIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.length
      ? issue.path
          .map((part) =>
            typeof part === "number"
              ? part
              : fields.has(String(part))
                ? String(part)
                : "[field]"
          )
          .join(".")
      : "$",
    code: issue.code,
  }))
}

export class ModelDispatcher implements DispatchPlanner {
  readonly model: string
  private readonly provider: ModelProvider
  constructor(model: string, provider: ModelProvider) {
    this.model = model
    this.provider = provider
  }
  async plan(input: DispatchPlanningInput): Promise<DispatchProposal> {
    let repair:
      | { previousProposal: unknown; issues: DispatchValidationIssue[] }
      | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const output = await this.provider.generateStructured({
        role: "dispatcher",
        system: [
          dispatcherPrompt,
          crossingPlanningGuidance,
          junctionPlanningGuidance,
          "Return only JSON matching this schema:",
          JSON.stringify(z.toJSONSchema(dispatchProposalSchema)),
        ].join("\n\n"),
        input: repair ? { ...input, repair } : input,
      })
      const result = dispatchProposalSchema.safeParse(output)
      if (result.success) return result.data
      repair = {
        previousProposal: output,
        issues: validationIssues(result.error),
      }
    }
    throw new DispatchProposalError(repair!.issues)
  }
}

/** Offline simulation, not a claim that a model understood or implemented the goal. */
export class FakeDispatchPlanner implements DispatchPlanner {
  readonly model = "fake"
  async plan(input: DispatchPlanningInput): Promise<DispatchProposal> {
    return {
      summary:
        "Simulated plan for offline development. Real planning uses the configured Dispatcher model.",
      lines: [
        {
          key: "goal",
          name: "Goal Line",
          unloadRecommendation: {
            mode: "auto",
            reason:
              "Offline simulation of a bounded change; review the selection before launch.",
          },
          stations: [
            {
              key: "implement",
              name: "Implement goal",
              manifest: {
                goal: input.goal.slice(0, 2000),
                repositoryChange: {
                  kind: "implementation",
                  description: input.goal.slice(0, 2000),
                },
                scope: [input.goal.slice(0, 2000)],
                expectedAreas: ["src/App.tsx"],
                avoidAreas: ["package.json"],
                contracts: [],
                invariants: ["Existing behavior remains intact"],
                dependencies: [],
                acceptanceCriteria: [
                  "The requested goal is implemented and project checks pass",
                ],
                expectedEvidence: input.network.validationNames,
              },
            },
          ],
        },
      ],
    }
  }
}
