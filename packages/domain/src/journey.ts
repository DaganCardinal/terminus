import { nextStop, type Crossing } from "./crossing"
import type { Car, ConductorReview } from "./car"
import {
  evaluateDeparture,
  evaluateStationRetry,
  type DepartureContext,
} from "./engineer"
import { unmetRequiredChecks } from "./evidence"
import type { CarId } from "./ids"
import { lineStations, nextStation, type Line } from "./line"
import type {
  Proposal,
  ReviewFeedback,
  Station,
  StationWorkspace,
} from "./station"
import type { Train } from "./train"
import { accept, gateClosed, reject, type Transition } from "./transition"

export interface TrainAndStation {
  train: Train
  station: Station
}

export interface DepartInput {
  train: Train
  line: Line
  /** At least every Station on the Train's Line. */
  stations: Station[]
  context: DepartureContext
  crossings?: Crossing[]
}

/**
 * Departs the Train toward its next Station and signals that Station. This is
 * what starts the Station's work. The Engineer's gate must be clear.
 */
export function depart(input: DepartInput): Transition<TrainAndStation> {
  const { train, line, context } = input
  if (train.state.status !== "ready") {
    return reject(
      "invalid_state",
      `Train ${train.id} cannot depart while ${train.state.status}`
    )
  }
  if (line.id !== train.lineId) {
    return reject(
      "invalid_input",
      `Train ${train.id} is not on Line ${line.id}`
    )
  }
  const ordered = lineStations(line, input.stations)
  if (!ordered) {
    return reject("invalid_input", `Missing Stations for Line ${line.id}`)
  }
  const stop = nextStop(line, ordered, input.crossings ?? [])
  if (stop?.kind === "crossing")
    return reject(
      "invalid_state",
      "Train must pick up its next Crossing before departing toward owned work"
    )
  const station = nextStation(ordered)
  if (!station) {
    return reject(
      "invalid_state",
      `Train ${train.id} has no Stations left and should return to Terminus`
    )
  }
  if (station.state.status !== "waiting") {
    return reject(
      "invalid_state",
      `Next Station ${station.id} is ${station.state.status}, not waiting`
    )
  }

  const decision = evaluateDeparture(train, station, context)
  if (decision.kind !== "clear") {
    return gateClosed(
      decision,
      `Train ${train.id} cannot depart toward ${station.id}: ${decision.kind}`
    )
  }

  return accept(
    {
      train: {
        ...train,
        state: {
          status: "in_transit",
          from: train.state.at,
          toward: station.id,
        },
      },
      station: {
        ...station,
        state: { status: "signaled", trainId: train.id, workspace: null },
      },
    },
    [
      { type: "train.departed", trainId: train.id, stationId: station.id },
      { type: "station.signaled", stationId: station.id, trainId: train.id },
    ]
  )
}

/**
 * Records the Station's workspace. It must be forked from the Train's latest
 * accepted commit, so the Station builds on every Car already attached.
 */
export function recordWorkspace(
  input: TrainAndStation & { workspace: StationWorkspace }
): Transition<Station> {
  const { train, station, workspace } = input
  const { state } = station
  if (state.status !== "signaled" || state.trainId !== train.id) {
    return reject(
      "invalid_state",
      `Station ${station.id} is not signaled by Train ${train.id}`
    )
  }
  if (state.workspace !== null) {
    return reject(
      "invalid_state",
      `Station ${station.id} already has a workspace`
    )
  }
  if (workspace.baseCommit !== train.headCommit) {
    return reject(
      "stale_base",
      `Workspace for ${station.id} is based on ${workspace.baseCommit}, but Train ${train.id} is at ${train.headCommit}`
    )
  }
  return accept({ ...station, state: { ...state, workspace } }, [
    {
      type: "station.workspace_created",
      stationId: station.id,
      repoId: workspace.repoId,
      baseCommit: workspace.baseCommit,
    },
  ])
}

/**
 * Marks proposed work ready for pickup. On a first pass the Train begins its
 * approach; on a revision the Train is already docked and stays there.
 */
export function markReadyForPickup(
  input: TrainAndStation & { proposal: Proposal }
): Transition<TrainAndStation> {
  const { train, station, proposal } = input
  const { state } = station
  if (
    (state.status !== "active" && state.status !== "revising") ||
    state.trainId !== train.id
  ) {
    return reject(
      "invalid_state",
      `Station ${station.id} has no work in progress for Train ${train.id}`
    )
  }

  const readyStation: Station = {
    ...station,
    state: {
      status: "ready_for_pickup",
      trainId: train.id,
      workspace: state.workspace,
      proposal,
    },
  }
  const ready = {
    type: "station.ready_for_pickup",
    stationId: station.id,
    headCommit: proposal.headCommit,
  } as const

  if (state.status === "active") {
    if (
      train.state.status !== "in_transit" ||
      train.state.toward !== station.id
    ) {
      return reject(
        "invalid_state",
        `Train ${train.id} is not in transit toward ${station.id}`
      )
    }
    return accept(
      {
        train: {
          ...train,
          state: {
            status: "approaching",
            from: train.state.from,
            toward: station.id,
          },
        },
        station: readyStation,
      },
      [
        ready,
        { type: "train.approaching", trainId: train.id, stationId: station.id },
      ]
    )
  }

  if (train.state.status !== "docked" || train.state.at !== station.id) {
    return reject(
      "invalid_state",
      `Train ${train.id} is not docked at ${station.id}`
    )
  }
  return accept({ train, station: readyStation }, [ready])
}

export function arrive(train: Train): Transition<Train> {
  if (train.state.status !== "approaching") {
    return reject(
      "invalid_state",
      `Train ${train.id} cannot arrive while ${train.state.status}`
    )
  }
  const { from, toward } = train.state
  return accept(
    {
      ...train,
      state: {
        status: "docked",
        from,
        at: toward,
        ...(train.state.crossingId
          ? { crossingId: train.state.crossingId }
          : {}),
      },
    },
    [{ type: "train.arrived", trainId: train.id, stationId: toward }]
  )
}

export function startReview(
  input: TrainAndStation
): Transition<TrainAndStation> {
  const { train, station } = input
  if (train.state.status !== "docked" || train.state.at !== station.id) {
    return reject(
      "invalid_state",
      `Train ${train.id} is not docked at ${station.id}`
    )
  }
  const { state } = station
  if (state.status !== "ready_for_pickup") {
    return reject(
      "invalid_state",
      `Station ${station.id} has no work ready for pickup`
    )
  }
  return accept(
    {
      train: {
        ...train,
        state: { status: "reviewing", from: train.state.from, at: station.id },
      },
      station: { ...station, state: { ...state, status: "in_review" } },
    },
    [{ type: "review.started", trainId: train.id, stationId: station.id }]
  )
}

export interface AttachCarInput extends TrainAndStation {
  carId: CarId
  review: ConductorReview
  /** ISO 8601 timestamp. */
  acceptedAt: string
}

/**
 * Accepts reviewed Station work onto the Train as a Car. Acceptance is a
 * fast-forward: the work must sit directly on the Train's latest commit, and
 * every required check must have passed.
 */
export function attachCar(
  input: AttachCarInput
): Transition<TrainAndStation & { car: Car }> {
  const { train, station } = input
  if (train.state.status !== "reviewing" || train.state.at !== station.id) {
    return reject(
      "invalid_state",
      `Train ${train.id} is not reviewing ${station.id}`
    )
  }
  const { state } = station
  if (state.status !== "in_review") {
    return reject("invalid_state", `Station ${station.id} is not in review`)
  }

  const failing = unmetRequiredChecks(
    state.proposal.evidence,
    station.manifest.expectedEvidence
  )
  if (failing.length > 0) {
    return reject(
      "required_checks_failed",
      `Cannot accept ${station.id}: ${failing.map((check) => check.name).join(", ")} did not pass`
    )
  }
  if (state.workspace.baseCommit !== train.headCommit) {
    return reject(
      "not_fast_forward",
      `Station ${station.id} was forked from ${state.workspace.baseCommit}, but Train ${train.id} has moved to ${train.headCommit}`
    )
  }

  const car: Car = {
    id: input.carId,
    trainId: train.id,
    stationId: station.id,
    position: train.carIds.length + 1,
    manifest: station.manifest,
    stationAgent: state.proposal.agent,
    sourceCommit: state.workspace.baseCommit,
    acceptedCommit: state.proposal.headCommit,
    changedPaths: state.proposal.changedPaths,
    ...(state.proposal.diff === undefined ? {} : { diff: state.proposal.diff }),
    evidence: state.proposal.evidence,
    agentSummary: state.proposal.agentSummary,
    review: input.review,
    acceptedAt: input.acceptedAt,
  }
  return accept(
    {
      car,
      train: {
        ...train,
        headCommit: car.acceptedCommit,
        carIds: [...train.carIds, car.id],
        state: {
          status: "ready",
          at: { kind: "station", stationId: station.id },
        },
      },
      station: {
        ...station,
        state: { status: "complete", trainId: train.id, carId: car.id },
      },
    },
    [
      {
        type: "car.attached",
        carId: car.id,
        trainId: train.id,
        stationId: station.id,
        acceptedCommit: car.acceptedCommit,
      },
    ]
  )
}

/**
 * Returns reviewed work to the Station Agent with feedback. The Train waits
 * docked while the Station revises.
 */
export function returnToStation(
  input: TrainAndStation & { feedback: ReviewFeedback; maxRetries?: number }
): Transition<TrainAndStation> {
  const { train, station, feedback } = input
  if (train.state.status !== "reviewing" || train.state.at !== station.id) {
    return reject(
      "invalid_state",
      `Train ${train.id} is not reviewing ${station.id}`
    )
  }
  const { state } = station
  if (state.status !== "in_review") {
    return reject("invalid_state", `Station ${station.id} is not in review`)
  }
  const decision = evaluateStationRetry(station, input.maxRetries)
  if (decision.kind !== "clear")
    return gateClosed(
      decision,
      `Station ${station.id} cannot retry: ${decision.kind}`
    )
  return accept(
    {
      train: {
        ...train,
        state: { status: "docked", from: train.state.from, at: station.id },
      },
      station: {
        ...station,
        revisionCount: station.revisionCount + 1,
        retryCount: (station.retryCount ?? station.revisionCount) + 1,
        lastReview: {
          workspace: state.workspace,
          proposal: state.proposal,
          feedback,
        },
        state: {
          status: "revising",
          trainId: train.id,
          workspace: state.workspace,
          feedback,
        },
      },
    },
    [
      {
        type: "station.returned",
        stationId: station.id,
        trainId: train.id,
        feedback,
      },
    ]
  )
}
