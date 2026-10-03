import type { Conflict } from "./conflict"
import { openConflictsFor } from "./conflict"
import { evaluateTerminusEntry, type GateContext } from "./engineer"
import { failingRequiredChecks, type Evidence } from "./evidence"
import type { CommitId } from "./ids"
import { lineStations, type Line } from "./line"
import type { Station } from "./station"
import type { Train } from "./train"
import { accept, gateClosed, reject, type Transition } from "./transition"

/**
 * Starts the Train's final leg once every Station on its Line is complete or
 * cancelled, and asks the Dispatcher for clearance into Terminus.
 */
export function beginReturn(input: {
  train: Train
  line: Line
  stations: Station[]
}): Transition<Train> {
  const { train, line } = input
  if (train.state.status !== "ready") {
    return reject(
      "invalid_state",
      `Train ${train.id} cannot return while ${train.state.status}`
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
  const remaining = ordered.filter(
    (station) =>
      station.state.status !== "complete" &&
      station.state.status !== "cancelled"
  )
  if (remaining.length > 0) {
    return reject(
      "stations_remaining",
      `Train ${train.id} still has Stations ahead: ${remaining.map((station) => station.id).join(", ")}`
    )
  }
  return accept(
    {
      ...train,
      state: { status: "returning", phase: "awaiting_clearance" },
    },
    [
      { type: "train.returning", trainId: train.id },
      { type: "terminus.integration_requested", trainId: train.id },
    ]
  )
}

/** The Dispatcher clears a returning Train to integrate into Terminus. */
export function clearForTerminus(input: {
  train: Train
  context: GateContext
}): Transition<Train> {
  const { train, context } = input
  if (
    train.state.status !== "returning" ||
    train.state.phase !== "awaiting_clearance"
  ) {
    return reject(
      "invalid_state",
      `Train ${train.id} is not waiting for clearance into Terminus`
    )
  }
  const decision = evaluateTerminusEntry(train, context)
  if (decision.kind !== "clear") {
    return gateClosed(
      decision,
      `Train ${train.id} cannot enter Terminus: ${decision.kind}`
    )
  }
  return accept(
    { ...train, state: { status: "returning", phase: "integrating" } },
    [{ type: "terminus.integration_started", trainId: train.id }]
  )
}

/**
 * Records a successful merge into Terminus. Project-wide validation must have
 * passed and no conflict involving the Train may be open.
 */
export function completeIntegration(input: {
  train: Train
  mergeCommit: CommitId
  evidence: Evidence
  conflicts: Conflict[]
}): Transition<Train> {
  const { train, mergeCommit } = input
  if (
    train.state.status !== "returning" ||
    train.state.phase !== "integrating"
  ) {
    return reject("invalid_state", `Train ${train.id} is not integrating`)
  }
  const failing = failingRequiredChecks(input.evidence.checks)
  if (failing.length > 0) {
    return reject(
      "required_checks_failed",
      `Train ${train.id} cannot unload: ${failing.map((check) => check.name).join(", ")} did not pass`
    )
  }
  const open = openConflictsFor(train.id, input.conflicts)
  if (open.length > 0) {
    return reject(
      "open_conflicts",
      `Train ${train.id} cannot unload with open conflicts: ${open.map((conflict) => conflict.id).join(", ")}`
    )
  }
  return accept({ ...train, state: { status: "unloaded", mergeCommit } }, [
    { type: "terminus.integration_completed", trainId: train.id, mergeCommit },
    { type: "train.unloaded", trainId: train.id },
  ])
}
