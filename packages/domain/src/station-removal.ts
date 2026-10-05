import { nextStation, type Line } from "./line"
import { cancelStation, type Station } from "./station"
import { clearTrainBlock, isTerminal, type Train } from "./train"
import { accept, reject, type Transition } from "./transition"

export interface StationRemovalInput {
  train: Train
  line: Line
  station: Station
  /** All network Stations, including cross-Line dependents. */
  stations: Station[]
  reason: string
  crossings?: import("./crossing").Crossing[]
}

/** Cancellation preserves topology and history; it never satisfies a dependency. */
export function removeStation(
  input: StationRemovalInput
): Transition<{ train: Train; station: Station }> {
  const { train, line, station, stations, reason } = input
  if (line.origin?.kind === "junction" || line.destination?.kind === "junction")
    return reject(
      "invalid_input",
      "Junction routes are fixed at launch; abandon the feature instead of removing its Stations"
    )
  if (isTerminal(train))
    return reject("invalid_state", "A terminal Train cannot remove Stations")
  if (
    train.lineId !== line.id ||
    station.lineId !== line.id ||
    !line.stationIds.includes(station.id)
  )
    return reject("invalid_input", "Station and Train must belong to this Line")
  if (
    input.crossings?.some(
      (c) => c.sourceStationId === station.id && c.state.status !== "complete"
    )
  )
    return reject(
      "invalid_input",
      "Unfinished Crossings depend on this Station"
    )
  const dependents = stations.filter(
    (other) =>
      other.id !== station.id &&
      other.state.status !== "complete" &&
      other.state.status !== "cancelled" &&
      other.manifest.dependencies.includes(station.id)
  )
  if (dependents.length)
    return reject(
      "invalid_input",
      `Cannot remove ${station.name}: unfinished Stations depend on it (${dependents.map((s) => s.name).join(", ")}). Revise their dependencies first.`
    )
  if (
    station.state.status === "blocked" &&
    (train.state.status !== "blocked" || station.state.trainId !== train.id)
  )
    return reject(
      "invalid_state",
      "A blocked Station must belong to its blocked Train"
    )
  const cancelled = cancelStation(station, reason)
  if (!cancelled.ok) return cancelled
  let updated = train
  const events = [...cancelled.events]
  if (train.state.status === "blocked") {
    const ordered = line.stationIds
      .map((id) => stations.find((s) => s.id === id))
      .filter((s): s is Station => !!s)
    const atRejectedGate =
      station.state.status === "waiting" &&
      nextStation(ordered)?.id === station.id &&
      train.state.issues.every(
        (issue) => issue.kind === "station_change_required"
      )
    const discardedWork =
      station.state.status === "blocked" &&
      train.state.issues.every((issue) =>
        [
          "station_failed",
          "station_retries_exhausted",
          "review_escalated",
          "required_checks_failed",
        ].includes(issue.kind)
      ) &&
      !stations.some(
        (other) =>
          other.id !== station.id &&
          other.state.status === "blocked" &&
          other.state.trainId === train.id
      )
    if (atRejectedGate || discardedWork) {
      const cleared = clearTrainBlock(train)
      if (!cleared.ok) return cleared
      updated = cleared.value
      events.push(...cleared.events)
    }
  }
  return accept({ train: updated, station: cancelled.value }, events)
}

export function requestStationRemoval(
  input: StationRemovalInput
): Transition<Station> {
  const checked = removeStation(input)
  if (!checked.ok) return checked
  if (input.station.removalRequest) return accept(input.station, [])
  return accept(
    { ...input.station, removalRequest: { reason: input.reason } },
    [
      {
        type: "station.removal_requested",
        stationId: input.station.id,
        reason: input.reason,
      },
    ]
  )
}
