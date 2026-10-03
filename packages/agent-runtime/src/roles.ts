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
import type { ConductorVerdict, ValidationCommand } from "@terminus/protocol"

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
  { ok: true; proposal: Proposal } | { ok: false; issues: Issue[] }

/**
 * Runs a Station Agent on one manifest and returns the committed work, with
 * evidence from orchestration's own validation run.
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

/** Reviews Station work against its manifest and the Train's current state. */
export interface Conductor {
  readonly model: string
  review(input: ReviewInput): Promise<ConductorVerdict>
}
