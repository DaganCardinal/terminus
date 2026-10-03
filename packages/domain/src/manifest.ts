import type { StationId } from "./ids"

export type ContractKind = "api" | "schema" | "symbol" | "config" | "other"

/** How a Station relates to a contract. */
export type ContractChange = "adds" | "changes" | "depends_on"

export interface Contract {
  name: string
  kind: ContractKind
  change: ContractChange
}

/**
 * The structured definition of a Station. This is domain state, not a prompt.
 * A copy placed in a Station workspace is agent context only.
 */
export interface WorkManifest {
  goal: string
  /** What the Station covers, in prose. */
  scope: string[]
  /** Paths or globs the Station is expected to change. */
  expectedAreas: string[]
  /** Paths or globs the Station must not change. */
  avoidAreas: string[]
  contracts: Contract[]
  invariants: string[]
  /** Stations, on this Line or another, that must be complete first. */
  dependencies: StationId[]
  acceptanceCriteria: string[]
  expectedEvidence: string[]
}
