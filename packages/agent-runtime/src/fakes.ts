import type { AgentConfig } from "@terminus/domain"
import type { ConductorVerdict } from "@terminus/protocol"
import type {
  Conductor,
  ReviewInput,
  StationRunInput,
  StationRunner,
  StationRunResult,
} from "./roles"

export interface FakeStationRunnerOptions {
  /** Awaited before each run returns, so the network visibly moves. */
  delay?: () => Promise<void>
}

/**
 * Pretends to implement a manifest. It "changes" the manifest's expected
 * areas and reports passing checks. Commits are derived from the run id.
 */
export class FakeStationRunner implements StationRunner {
  readonly config: AgentConfig = { harness: "fake", model: "fake" }
  readonly #delay: (() => Promise<void>) | undefined

  constructor(options: FakeStationRunnerOptions = {}) {
    this.#delay = options.delay
  }

  async run(input: StationRunInput): Promise<StationRunResult> {
    await this.#delay?.()
    return {
      ok: true,
      proposal: {
        headCommit: `fake-${input.runId}`,
        changedPaths: input.manifest.expectedAreas,
        evidence: {
          checks: (
            input.validation?.map((check) => check.name) ?? [
              "typecheck",
              "test",
            ]
          ).map((name) => ({
            name,
            required: true,
            status: "passed" as const,
          })),
        },
        agent: this.config,
        agentSummary: input.feedback
          ? `Addressed: ${input.feedback.summary}`
          : `Implemented: ${input.manifest.goal}`,
      },
    }
  }
}

export interface FakeConductorOptions {
  /** How many times to return each Station's work before accepting it. */
  returns?: number
}

/** Accepts work, optionally after returning it a fixed number of times. */
export class FakeConductor implements Conductor {
  readonly model = "fake"
  readonly #returns: number

  constructor(options: FakeConductorOptions = {}) {
    this.#returns = options.returns ?? 0
  }

  async review(input: ReviewInput): Promise<ConductorVerdict> {
    if (input.revisionCount < this.#returns) {
      return {
        verdict: "return",
        summary: "Needs another pass",
        findings: [`Revision ${input.revisionCount + 1} requested`],
      }
    }
    return {
      verdict: "accept",
      summary: "Meets the manifest",
      findings: [],
    }
  }
}
