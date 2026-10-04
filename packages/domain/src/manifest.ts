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
  /** Explicit repository deliverable. Optional only for older persisted manifests. */
  repositoryChange?: {
    kind:
      | "implementation"
      | "tests"
      | "documentation"
      | "configuration"
      | "verification"
    description: string
  }
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

/** Checks declared intent, not whether execution will actually produce a diff. */
export function hasConcreteRepositoryChange(manifest: WorkManifest): boolean {
  const change = manifest.repositoryChange
  return (
    !!change &&
    ["implementation", "tests", "documentation", "configuration"].includes(
      change.kind
    ) &&
    !!change.description.trim() &&
    manifest.expectedAreas.length > 0 &&
    manifest.expectedAreas.every((path) => !!path.trim())
  )
}
