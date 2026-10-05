import type { Evidence } from "./evidence"
import type { CarId, CommitId, StationId, TrainId } from "./ids"
import type { WorkManifest } from "./manifest"

/** The harness and model configuration a Station Agent ran with. */
export interface AgentConfig {
  harness: string
  model: string
}

export interface ConductorReview {
  summary: string
  findings: string[]
  model: string
}

/**
 * One accepted unit of work on a Train, with the provenance to explain it.
 * It references the Train repository and has no repository of its own.
 */
export interface Car {
  id: CarId
  trainId: TrainId
  stationId: StationId
  /** 1-based position on the Train. */
  position: number
  /** The manifest as it was when the work was accepted. */
  manifest: WorkManifest
  stationAgent: AgentConfig
  /** The Train commit the Station was forked from. */
  sourceCommit: CommitId
  acceptedCommit: CommitId
  changedPaths: string[]
  diff?: string
  evidence: Evidence
  agentSummary: string | null
  review: ConductorReview
  /** ISO 8601 timestamp. */
  acceptedAt: string
  originCarId?: string
  sourceCarId?: string
  junctionId?: string
  crossingId?: string
  copiedAt?: string
}
