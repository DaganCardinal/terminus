import type {
  AgentConfig,
  CommitId,
  Issue,
  Proposal,
  ReviewFeedback,
  StationId,
  StationWorkspace,
  WorkManifest,
} from "@terminus/domain"
import type {
  CrossingReviewInput,
  ConductorVerdict,
  StationVerdict,
  ValidationCommand,
} from "@terminus/protocol"

export interface StationRunInput {
  stationId: StationId
  runId: string
  manifest: WorkManifest
  workspace: StationWorkspace
  /** The Conductor's feedback when this run is a revision. */
  feedback: ReviewFeedback | null
  /** Trusted project configuration from D1, never supplied by the harness. */
  validation?: ValidationCommand[]
}

export type StationRunResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; issues: Issue[]; phase?: string }

/**
 * Runs a Station Agent on one manifest and returns the committed work. Its
 * evidence comes from orchestration's own validation run, or is empty when the
 * Conductor collects it during review.
 */
export interface StationRunner {
  readonly config: AgentConfig
  run(input: StationRunInput): Promise<StationRunResult>
}

export interface ReviewInput {
  stationId: StationId
  manifest: WorkManifest
  proposal: Proposal
  /** The Train commit the work must fast-forward from. */
  trainHead: CommitId
  /** How many times this Station's work has already been returned. */
  revisionCount: number
}

/**
 * Where the candidate lives, for a Conductor that verifies it in a Sandbox.
 * Kept apart from review inputs, which identify durable verdicts.
 */
export interface ReviewContext {
  /** The repository holding the candidate commit under review. */
  repoId: string
  /** Trusted project configuration from D1, never supplied by a model. */
  validation?: ValidationCommand[]
}

/** Reviews Station work against its manifest and the Train's current state. */
export interface Conductor {
  readonly config?: AgentConfig
  readonly model: string
  /** Work arriving without evidence may get it collected here. */
  review(input: ReviewInput, context: ReviewContext): Promise<StationVerdict>
  reviewJunction?(
    input: import("@terminus/protocol").JunctionReviewInput,
    context: ReviewContext
  ): Promise<ConductorVerdict>
  reviewCrossing?(
    input: CrossingReviewInput,
    context: ReviewContext
  ): Promise<ConductorVerdict>
}

export type { CrossingReviewInput } from "@terminus/protocol"
