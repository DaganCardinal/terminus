import type { LineId, NetworkId, StationId } from "./ids"
import type { WorkManifest } from "./manifest"
import type { Station } from "./station"
import { accept, reject, type Transition } from "./transition"

/** An ordered workstream from its depot, through its Stations, to Terminus. */
export interface Line {
  id: LineId
  networkId: NetworkId
  name: string
  /** Stations in travel order, depot first. */
  stationIds: StationId[]
}

export interface StationPlan {
  id: StationId
  name: string
  manifest: WorkManifest
}

export interface CreateLineInput {
  id: LineId
  networkId: NetworkId
  name: string
  /** In travel order, depot first. */
  stations: StationPlan[]
}

export function createLine(
  input: CreateLineInput
): Transition<{ line: Line; stations: Station[] }> {
  if (input.stations.length === 0) {
    return reject(
      "invalid_input",
      `Line ${input.id} needs at least one Station`
    )
  }

  const onLine = new Set(input.stations.map((station) => station.id))
  const seen = new Set<StationId>()
  for (const plan of input.stations) {
    if (seen.has(plan.id)) {
      return reject("invalid_input", `Station ${plan.id} appears twice`)
    }
    // A dependency on a later Station of the same Line could never be met,
    // because the Train reaches Stations in order.
    for (const dependency of plan.manifest.dependencies) {
      if (onLine.has(dependency) && !seen.has(dependency)) {
        return reject(
          "invalid_input",
          `Station ${plan.id} depends on ${dependency}, which is not before it on the Line`
        )
      }
    }
    seen.add(plan.id)
  }

  const line: Line = {
    id: input.id,
    networkId: input.networkId,
    name: input.name,
    stationIds: input.stations.map((plan) => plan.id),
  }
  const stations: Station[] = input.stations.map((plan) => ({
    id: plan.id,
    lineId: line.id,
    name: plan.name,
    manifest: plan.manifest,
    revisionCount: 0,
    state: { status: "waiting" },
  }))
  return accept({ line, stations }, [
    { type: "line.created", lineId: line.id, stationIds: line.stationIds },
  ])
}

/**
 * The Line's Stations in travel order, or null if any are missing from
 * `stations`.
 */
export function lineStations(
  line: Line,
  stations: Station[]
): Station[] | null {
  const byId = new Map(stations.map((station) => [station.id, station]))
  const ordered: Station[] = []
  for (const id of line.stationIds) {
    const station = byId.get(id)
    if (!station) return null
    ordered.push(station)
  }
  return ordered
}

/** The first Station still ahead of the Train, or null if none remain. */
export function nextStation(ordered: Station[]): Station | null {
  return (
    ordered.find(
      (station) =>
        station.state.status !== "complete" &&
        station.state.status !== "cancelled"
    ) ?? null
  )
}
