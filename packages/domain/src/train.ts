import type { HoldReason } from "./hold"
import type { CarId, CommitId, LineId, RepoId, StationId, TrainId } from "./ids"
import type { Issue } from "./issue"
import type { Line } from "./line"
import { accept, reject, type Transition } from "./transition"

/** Where a stopped Train is on the map. */
export type TrainLocation =
  | { kind: "depot" }
  | { kind: "station"; stationId: StationId }
  | { kind: "junction"; junctionId: string }

export interface TrainReady {
  status: "ready"
  at: TrainLocation
}

export interface TrainInTransit {
  status: "in_transit"
  from: TrainLocation
  toward: StationId
}

export interface TrainApproaching {
  crossingId?: string
  status: "approaching"
  from: TrainLocation
  toward: StationId
}

export interface TrainDocked {
  crossingId?: string
  status: "docked"
  from: TrainLocation
  at: StationId
}

export interface TrainReviewing {
  crossingId?: string
  status: "reviewing"
  from: TrainLocation
  at: StationId
}

export type ReturnPhase = "awaiting_clearance" | "integrating"

export interface TrainReturning {
  status: "returning"
  phase: ReturnPhase
}

/** The states a held or blocked Train goes back to when released or cleared. */
export type TrainResume =
  TrainReady | { status: "returning"; phase: "awaiting_clearance" }

export interface TrainHeld {
  status: "held"
  reasons: HoldReason[]
  resume: TrainResume
}

export interface TrainBlocked {
  status: "blocked"
  issues: Issue[]
  resume: TrainResume
}

export interface TrainUnloaded {
  status: "unloaded"
  destination?: import("./junction").LineDestination
  mergeCommit: CommitId
}

export interface TrainSided {
  status: "siding"
  reason: string
}

export type TrainState =
  | TrainReady
  | TrainInTransit
  | TrainApproaching
  | TrainDocked
  | TrainReviewing
  | TrainHeld
  | TrainBlocked
  | TrainReturning
  | TrainUnloaded
  | TrainSided

export type TrainStatus = TrainState["status"]

export interface Train {
  destination?: import("./junction").LineDestination
  junctionId?: string
  integrationIds?: string[]
  repairIds?: string[]
  id: TrainId
  lineId: LineId
  repoId: RepoId
  /** The Terminus commit the Train's repository was forked from. */
  terminusBaseline: CommitId
  /** The Train repository's latest accepted commit. */
  headCommit: CommitId
  /** Attached Cars, in order. */
  carIds: CarId[]
  state: TrainState
}

export interface CreateTrainInput {
  id: TrainId
  line: Line
  repoId: RepoId
  terminusCommit: CommitId
  headCommit?: CommitId
}

/** Creates a Train at its Line's depot, forked from the given Terminus state. */
export function createTrain(input: CreateTrainInput): Transition<Train> {
  const train: Train = {
    id: input.id,
    lineId: input.line.id,
    repoId: input.repoId,
    terminusBaseline: input.terminusCommit,
    headCommit: input.headCommit ?? input.terminusCommit,
    ...(input.line.destination ? { destination: input.line.destination } : {}),
    carIds: [],
    state: { status: "ready", at: input.line.origin ?? { kind: "depot" } },
  }
  return accept(train, [
    {
      type: "train.created",
      trainId: train.id,
      lineId: train.lineId,
      repoId: train.repoId,
      terminusBaseline: train.terminusBaseline,
    },
  ])
}

export function isTerminal(train: Train): boolean {
  return train.state.status === "unloaded" || train.state.status === "siding"
}

/**
 * Holds a Train at a gate. A Train can only be held where it is stopped at a
 * gate: ready to depart, or waiting for clearance into Terminus.
 */
export function holdTrain(
  train: Train,
  reasons: HoldReason[]
): Transition<Train> {
  if (reasons.length === 0) {
    return reject("invalid_input", "Holding a Train requires a reason")
  }
  const { state } = train
  let resume: TrainResume
  if (state.status === "held") {
    if (JSON.stringify(state.reasons) === JSON.stringify(reasons))
      return accept(train, [])
    resume = state.resume
  } else if (state.status === "ready") {
    resume = state
  } else if (
    state.status === "returning" &&
    state.phase === "awaiting_clearance"
  ) {
    resume = { status: "returning", phase: "awaiting_clearance" }
  } else {
    return reject(
      "invalid_state",
      `Train ${train.id} can only be held at a gate, not while ${describe(state)}`
    )
  }
  return accept({ ...train, state: { status: "held", reasons, resume } }, [
    { type: "train.held", trainId: train.id, reasons },
  ])
}

/** Releases a held Train back to its gate. The gate is evaluated again there. */
export function releaseTrain(train: Train): Transition<Train> {
  if (train.state.status !== "held") {
    return reject("invalid_state", `Train ${train.id} is not held`)
  }
  return accept({ ...train, state: train.state.resume }, [
    { type: "train.released", trainId: train.id },
  ])
}

/**
 * Blocks a Train and raises the issue to the Dispatcher. When cleared, a Train
 * that was working toward a Station goes back to where it last stopped, so the
 * Station can be run again from the Train's state.
 */
export function blockTrain(train: Train, issues: Issue[]): Transition<Train> {
  if (issues.length === 0) {
    return reject("invalid_input", "Blocking a Train requires an issue")
  }
  const { state } = train
  let resume: TrainResume
  switch (state.status) {
    case "ready":
      resume = state
      break
    case "in_transit":
    case "approaching":
    case "docked":
    case "reviewing":
      resume = { status: "ready", at: state.from }
      break
    case "held":
      resume = state.resume
      break
    case "returning":
      resume = { status: "returning", phase: "awaiting_clearance" }
      break
    default:
      return reject(
        "invalid_state",
        `Train ${train.id} cannot be blocked while ${state.status}`
      )
  }
  return accept({ ...train, state: { status: "blocked", issues, resume } }, [
    { type: "train.blocked", trainId: train.id, issues },
    { type: "train.issue_raised", trainId: train.id, issues },
  ])
}

export function clearTrainBlock(train: Train): Transition<Train> {
  if (train.state.status !== "blocked") {
    return reject("invalid_state", `Train ${train.id} is not blocked`)
  }
  return accept({ ...train, state: train.state.resume }, [
    { type: "train.cleared", trainId: train.id },
  ])
}

/** Abandons a Train. It stays inspectable on the siding but no longer runs. */
export function sendToSiding(train: Train, reason: string): Transition<Train> {
  if (isTerminal(train)) {
    return reject(
      "invalid_state",
      `Train ${train.id} is already ${train.state.status}`
    )
  }
  return accept({ ...train, state: { status: "siding", reason } }, [
    { type: "train.sided", trainId: train.id, reason },
  ])
}

function describe(state: TrainState): string {
  return state.status === "returning"
    ? `returning (${state.phase})`
    : state.status
}
