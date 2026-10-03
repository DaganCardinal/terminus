import type { AgentConfig } from "./car"
import type { Evidence } from "./evidence"
import type { CarId, CommitId, LineId, RepoId, StationId, TrainId } from "./ids"
import type { Issue } from "./issue"
import type { WorkManifest } from "./manifest"
import { accept, reject, type Transition } from "./transition"

/** The Station's own repository, forked from the Train when it departed. */
export interface StationWorkspace {
  repoId: RepoId
  baseCommit: CommitId
}

/** Work a Station Agent has committed, with evidence collected by our code. */
export interface Proposal {
  headCommit: CommitId
  changedPaths: string[]
  /** Actual patch collected from Git, not the agent's description. */
  diff?: string
  evidence: Evidence
  /** The Station Agent configuration that produced the work. */
  agent: AgentConfig
  /** The agent's own account. Context for review, never evidence. */
  agentSummary: string | null
}

export interface ReviewFeedback {
  summary: string
  findings: string[]
}

export type StationState =
  | { status: "waiting" }
  | {
      status: "signaled"
      trainId: TrainId
      workspace: StationWorkspace | null
    }
  | { status: "active"; trainId: TrainId; workspace: StationWorkspace }
  | {
      status: "ready_for_pickup"
      trainId: TrainId
      workspace: StationWorkspace
      proposal: Proposal
    }
  | {
      status: "in_review"
      trainId: TrainId
      workspace: StationWorkspace
      proposal: Proposal
    }
  | {
      status: "revising"
      trainId: TrainId
      workspace: StationWorkspace
      feedback: ReviewFeedback
    }
  | { status: "blocked"; trainId: TrainId; issues: Issue[] }
  | { status: "complete"; trainId: TrainId; carId: CarId }
  | { status: "cancelled"; reason: string }

export type StationStatus = StationState["status"]

export interface Station {
  id: StationId
  lineId: LineId
  name: string
  manifest: WorkManifest
  /** How many times the Conductor has returned this Station's work. */
  revisionCount: number
  state: StationState
}

export function startStation(station: Station): Transition<Station> {
  const { state } = station
  if (state.status !== "signaled") {
    return reject(
      "invalid_state",
      `Station ${station.id} cannot start while ${state.status}`
    )
  }
  if (state.workspace === null) {
    return reject(
      "invalid_state",
      `Station ${station.id} cannot start before its workspace exists`
    )
  }
  return accept(
    {
      ...station,
      state: {
        status: "active",
        trainId: state.trainId,
        workspace: state.workspace,
      },
    },
    [{ type: "station.started", stationId: station.id }]
  )
}

export function blockStation(
  station: Station,
  issues: Issue[]
): Transition<Station> {
  const { state } = station
  if (issues.length === 0) {
    return reject("invalid_input", "Blocking a Station requires an issue")
  }
  switch (state.status) {
    case "signaled":
    case "active":
    case "ready_for_pickup":
    case "in_review":
    case "revising":
      return accept(
        {
          ...station,
          state: { status: "blocked", trainId: state.trainId, issues },
        },
        [{ type: "station.blocked", stationId: station.id, issues }]
      )
    default:
      return reject(
        "invalid_state",
        `Station ${station.id} cannot be blocked while ${state.status}`
      )
  }
}

/**
 * Clears a blocked Station back to `waiting`. Its next run forks a fresh
 * workspace from the Train's state at that departure.
 */
export function resetStation(station: Station): Transition<Station> {
  if (station.state.status !== "blocked") {
    return reject(
      "invalid_state",
      `Station ${station.id} can only be reset while blocked`
    )
  }
  return accept({ ...station, state: { status: "waiting" } }, [
    { type: "station.reset", stationId: station.id },
  ])
}

export function cancelStation(
  station: Station,
  reason: string
): Transition<Station> {
  const { status } = station.state
  if (status !== "waiting" && status !== "blocked") {
    return reject(
      "invalid_state",
      `Station ${station.id} cannot be cancelled while ${status}`
    )
  }
  return accept({ ...station, state: { status: "cancelled", reason } }, [
    { type: "station.cancelled", stationId: station.id, reason },
  ])
}
