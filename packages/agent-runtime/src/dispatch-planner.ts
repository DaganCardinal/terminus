import type {
  BaselineReport,
  DispatchProposal,
  PlanningContext,
} from "@terminus/domain"
import type { ValidationCommand, ActivityObserver } from "@terminus/protocol"

export interface DispatchPlanningInput {
  /** Stable execution address for backend cancellation. */
  planId?: string
  goal: string
  network: PlanningContext
  /** The exact Terminus snapshot the plan is reviewed against. */
  repository: { repoId: string; commit: string }
  /** Install dependencies and run trusted project checks before exploring. */
  checkBaseline: boolean
  /** Trusted project configuration from D1, never supplied by a model. */
  validation: ValidationCommand[]
  onActivity?: ActivityObserver
}

export interface DispatchPlanResult {
  proposal: DispatchProposal
  baseline: BaselineReport | null
}

export interface DispatchPlanner {
  readonly model: string
  readonly config?: import("@terminus/domain").AgentConfig
  plan(input: DispatchPlanningInput): Promise<DispatchPlanResult>
}

/** Offline simulation, not a claim that a model understood or implemented the goal. */
export class FakeDispatchPlanner implements DispatchPlanner {
  readonly model = "fake"
  async plan(input: DispatchPlanningInput): Promise<DispatchPlanResult> {
    input.onActivity?.({ kind: "phase", phase: "simulation" })
    const evidence = input.network.projectChecks.map((check) => check.name)
    const proposal: DispatchProposal = {
      summary:
        "Simulated plan for offline development. Real planning uses the configured Dispatcher model.",
      findings: [
        {
          topic: "Simulated exploration",
          summary:
            "Offline planning reads no repository content; this finding only demonstrates the review layout.",
          paths: ["src/App.tsx"],
        },
      ],
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
                expectedEvidence: evidence,
              },
            },
          ],
        },
      ],
    }
    if (!input.checkBaseline || !evidence.length)
      return { proposal, baseline: null }
    const [failing, ...passing] = evidence
    return {
      baseline: {
        commit: input.repository.commit,
        checks: [
          {
            name: "npm ci",
            status: "passed",
            exitCode: 0,
            outputTail: "Simulated install.",
            outputTruncated: false,
          },
          {
            name: failing!,
            status: "failed",
            exitCode: 1,
            outputTail: "Simulated baseline failure for offline development.",
            outputTruncated: false,
          },
          ...passing.map((name) => ({
            name,
            status: "passed" as const,
            exitCode: 0,
            outputTail: "Simulated check.",
            outputTruncated: false,
          })),
        ],
      },
      proposal: {
        ...proposal,
        baselineFix: {
          reason: `Simulated: the ${failing} check fails on the baseline, so every Station would inherit the failure.`,
          line: {
            key: "baseline-fix",
            name: "Baseline Fix Line",
            unloadRecommendation: {
              mode: "auto",
              reason: "Offline simulation of a bounded check repair.",
            },
            stations: [
              {
                key: "fix-baseline",
                name: "Fix failing baseline checks",
                manifest: {
                  goal: `Make the ${failing} check pass on the baseline`,
                  repositoryChange: {
                    kind: "implementation",
                    description: `Repair the code or tests that make ${failing} fail`,
                  },
                  scope: [`Only changes required for ${failing} to pass`],
                  expectedAreas: ["src/"],
                  avoidAreas: [],
                  contracts: [],
                  invariants: [
                    "No behavior unrelated to the failing check changes",
                  ],
                  dependencies: [],
                  acceptanceCriteria: [`${failing} passes`],
                  expectedEvidence: evidence,
                },
              },
            ],
          },
        },
      },
    }
  }
}
