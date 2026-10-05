import type { Car } from "./car"
import type { GateContext, GateDecision } from "./engineer"
import { blockingIssues, holdReasons } from "./engineer"
import type { Issue } from "./issue"
import type { Line } from "./line"
import type { Station } from "./station"
import type { Train } from "./train"
import { unmetRequiredChecks, type Evidence } from "./evidence"
import { blockTrain } from "./train"
import { accept, gateClosed, reject, type Transition } from "./transition"

export interface StationCheckpoint {
  stationId: string
  sourceTrainId: string
  repoId: string
  commit: string
  carIds: string[]
}
export interface Crossing {
  id: string
  networkId: string
  lineId: string
  sourceStationId: string
  checkpoint?: StationCheckpoint
  attempt: number
  retryRequested?: boolean
  state:
    | { status: "waiting" }
    | { status: "integrating"; integrationId: string }
    | {
        status: "complete"
        integrationId: string
        commit: string
        copiedCarIds: string[]
      }
    | { status: "blocked"; issues: Issue[]; integrationId?: string }
}
export type LineStop =
  | { kind: "station"; stationId: string }
  | { kind: "crossing"; crossingId: string; stationId: string }
export type PlannedStop =
  | { kind: "station"; key: string }
  | {
      kind: "crossing"
      source:
        | { kind: "planned"; stationKey: string }
        | { kind: "existing"; stationId: string }
    }

/** Legacy Station ordering is normalized to the authoritative route. */
export function lineStops(line: Line): LineStop[] {
  return (
    line.stops ??
    line.stationIds.map((stationId) => ({ kind: "station", stationId }))
  )
}
export function nextStop(
  line: Line,
  stations: Station[],
  crossings: Crossing[]
): LineStop | null {
  return (
    lineStops(line).find((stop) =>
      stop.kind === "crossing"
        ? crossings.find((c) => c.id === stop.crossingId)?.state.status !==
          "complete"
        : !["complete", "cancelled"].includes(
            stations.find((s) => s.id === stop.stationId)?.state.status ??
              "waiting"
          )
    ) ?? null
  )
}
export function stationCheckpoint(
  train: Train,
  station: Station
): StationCheckpoint | null {
  if (station.state.status !== "complete" || station.state.trainId !== train.id)
    return null
  const index = train.carIds.indexOf(station.state.carId)
  if (index < 0) return null
  return {
    stationId: station.id,
    sourceTrainId: train.id,
    repoId: train.repoId,
    commit: train.headCommit,
    carIds: train.carIds.slice(0, index + 1),
  }
}
export function evaluateCrossing(
  train: Train,
  crossing: Crossing,
  source: Station | undefined,
  sourceTrain: Train | undefined,
  context: GateContext
): GateDecision {
  const issues = blockingIssues(train, context)
  const reasons = holdReasons(train, context)
  if (!crossing.checkpoint) {
    if (
      !source ||
      source.state.status === "cancelled" ||
      source.removalRequest ||
      sourceTrain?.state.status === "siding"
    )
      issues.push({
        kind: "dependency_unresolvable",
        detail: `Crossing source ${crossing.sourceStationId} is unavailable`,
      })
    else
      reasons.push({ kind: "dependency", stationId: crossing.sourceStationId })
  }
  return issues.length
    ? { kind: "block", issues }
    : reasons.length
      ? { kind: "hold", reasons }
      : { kind: "clear" }
}
export function approachCrossing(
  train: Train,
  crossing: Crossing,
  context: GateContext
): Transition<Train> {
  if (
    train.state.status !== "ready" ||
    train.lineId !== crossing.lineId ||
    !crossing.checkpoint ||
    crossing.state.status !== "waiting"
  )
    return reject("invalid_state", "Crossing is not ready for pickup")
  const gate = evaluateCrossing(train, crossing, undefined, undefined, context)
  if (gate.kind !== "clear")
    return gateClosed(gate, "Crossing entry gate is closed")
  return accept(
    {
      ...train,
      state: {
        status: "approaching",
        from: train.state.at,
        toward: crossing.sourceStationId,
        crossingId: crossing.id,
      },
    },
    [
      {
        type: "train.approaching",
        trainId: train.id,
        stationId: crossing.sourceStationId,
      },
      {
        type: "crossing.approaching",
        crossingId: crossing.id,
        trainId: train.id,
        stationId: crossing.sourceStationId,
      },
    ]
  )
}
export function completeCrossing(
  train: Train,
  crossing: Crossing,
  sourceCars: Car[],
  receivingCars: Car[],
  commit: string,
  at: string,
  approval: {
    evidence: Evidence
    expectedChecks: string[]
    verdict: "accept" | "return" | "escalate"
  }
): Transition<{ train: Train; crossing: Crossing; cars: Car[] }> {
  if (
    train.state.status !== "reviewing" ||
    train.state.crossingId !== crossing.id ||
    crossing.state.status !== "integrating" ||
    !crossing.checkpoint
  )
    return reject("invalid_state", "Train is not reviewing this Crossing")
  if (approval.verdict !== "accept")
    return reject(
      "invalid_state",
      "Receiving Conductor did not accept the pickup"
    )
  if (unmetRequiredChecks(approval.evidence, approval.expectedChecks).length)
    return reject(
      "required_checks_failed",
      "Crossing candidate validation did not pass"
    )
  if (
    train.carIds.some(
      (id) => !receivingCars.some((c) => c.id === id && c.trainId === train.id)
    )
  )
    return reject("invalid_input", "Receiving Car provenance is incomplete")
  const seen = new Set(
    train.carIds.map((id) => {
      const car = receivingCars.find((car) => car.id === id)!
      return car.originCarId ?? car.id
    })
  )
  const cars: Car[] = []
  for (const id of crossing.checkpoint.carIds) {
    const source = sourceCars.find((car) => car.id === id)
    if (!source) return reject("invalid_input", `Missing checkpoint Car ${id}`)
    const originCarId = source.originCarId ?? source.id
    if (seen.has(originCarId)) continue
    seen.add(originCarId)
    cars.push({
      ...source,
      id: `${crossing.id}-car-${originCarId}`,
      trainId: train.id,
      position: train.carIds.length + cars.length + 1,
      originCarId,
      sourceCarId: source.id,
      crossingId: crossing.id,
      copiedAt: at,
    })
  }
  return accept(
    {
      train: {
        ...train,
        headCommit: commit,
        carIds: [...train.carIds, ...cars.map((c) => c.id)],
        state: {
          status: "ready",
          at: { kind: "station", stationId: crossing.sourceStationId },
        },
      },
      crossing: {
        ...crossing,
        state: {
          status: "complete",
          integrationId: crossing.state.integrationId,
          commit,
          copiedCarIds: cars.map((c) => c.id),
        },
      },
      cars,
    },
    [
      {
        type: "crossing.completed",
        crossingId: crossing.id,
        trainId: train.id,
        stationId: crossing.sourceStationId,
        mergeCommit: commit,
        carIds: cars.map((c) => c.id),
      },
    ]
  )
}
/** Validate causal order and one-way Line flow, independently of execution. */
export function validateCrossingTopology(
  lines: Line[],
  stations: Station[]
): string[] {
  const errors: string[] = []
  const byStation = new Map(stations.map((s) => [s.id, s]))
  const lineEdges = new Map<string, Set<string>>()
  const edges = new Map<string, Set<string>>()
  const link = (map: Map<string, Set<string>>, a: string, b: string) => {
    const set = map.get(a) ?? new Set<string>()
    set.add(b)
    map.set(a, set)
  }
  for (const line of lines) {
    const stops = lineStops(line)
    const pickupSources = stops
      .filter((s) => s.kind === "crossing")
      .map((s) => s.stationId)
    if (new Set(pickupSources).size !== pickupSources.length)
      errors.push(`Repeated Crossing source on ${line.name}`)
    const owned = stops
      .filter((s) => s.kind === "station")
      .map((s) => s.stationId)
    if (
      (!owned.length && line.origin?.kind !== "junction") ||
      owned.length !== line.stationIds.length ||
      new Set(owned).size !== owned.length ||
      owned.some((id) => byStation.get(id)?.lineId !== line.id) ||
      line.stationIds.some((id) => !owned.includes(id))
    )
      errors.push(`Invalid owned Stations on ${line.name}`)
    let prev: string | undefined
    for (const stop of stops) {
      const node = stop.kind === "station" ? stop.stationId : stop.crossingId
      if (prev) link(edges, prev, node)
      prev = node
      if (stop.kind === "crossing") {
        const source = byStation.get(stop.stationId)
        if (
          !source ||
          source.lineId === line.id ||
          source.state.status === "cancelled" ||
          source.removalRequest ||
          !lines.some(
            (l) => l.id === source.lineId && l.networkId === line.networkId
          )
        )
          errors.push(`Unavailable Crossing source ${stop.stationId}`)
        else if (
          JSON.stringify(
            lines.find((l) => l.id === source.lineId)?.destination ?? {
              kind: "terminus",
            }
          ) !== JSON.stringify(line.destination ?? { kind: "terminus" })
        )
          errors.push(
            "Crossings cannot transfer code across Junction boundaries"
          )
        else {
          link(lineEdges, source.lineId, line.id)
          link(edges, source.id, node)
        }
      } else
        for (const dependency of byStation.get(stop.stationId)?.manifest
          .dependencies ?? []) {
          const owner = lines.find(
            (l) => l.id === byStation.get(dependency)?.lineId
          )
          if (
            owner &&
            JSON.stringify(owner.destination ?? { kind: "terminus" }) !==
              JSON.stringify(line.destination ?? { kind: "terminus" }) &&
            !(
              line.origin?.kind === "junction" &&
              owner.destination?.kind === "junction" &&
              line.origin.junctionId === owner.destination.junctionId
            )
          )
            errors.push("Station dependencies cannot cross Junction boundaries")
          link(edges, dependency, node)
        }
    }
  }
  // A feature's complete membership precedes every stop on its outgoing Line.
  for (const outgoing of lines.filter((l) => l.origin?.kind === "junction")) {
    const junctionId = (
      outgoing.origin as { kind: "junction"; junctionId: string }
    ).junctionId
    const junctionNode = `junction:${junctionId}`
    const first = lineStops(outgoing)[0]
    if (first)
      link(
        edges,
        junctionNode,
        first.kind === "station" ? first.stationId : first.crossingId
      )
    for (const input of lines.filter(
      (l) =>
        l.destination?.kind === "junction" &&
        l.destination.junctionId === junctionId
    )) {
      const last = lineStops(input).at(-1)
      if (last)
        link(
          edges,
          last.kind === "station" ? last.stationId : last.crossingId,
          junctionNode
        )
      link(lineEdges, input.id, outgoing.id)
    }
  }
  const cyclic = (graph: Map<string, Set<string>>) => {
    const visiting = new Set<string>(),
      done = new Set<string>()
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true
      if (done.has(id)) return false
      visiting.add(id)
      for (const next of graph.get(id) ?? []) if (visit(next)) return true
      visiting.delete(id)
      done.add(id)
      return false
    }
    return [...graph.keys()].some(visit)
  }
  if (cyclic(lineEdges))
    errors.push("Crossing Lines must have an acyclic, one-way flow")
  if (cyclic(edges))
    errors.push("Station dependencies and Crossing stops form a cycle")
  return errors
}

export function resolveLineRoute(
  line: Line,
  route: PlannedStop[] | undefined,
  keys: Map<string, string>
): { line: Line; crossings: Crossing[] } {
  if (!route) return { line, crossings: [] }
  const crossings: Crossing[] = []
  const declared = [...line.stationIds]
  const stops: LineStop[] = route.map((stop, i) => {
    if (stop.kind === "station") {
      const id = keys.get(stop.key)
      if (!id) throw new Error(`Unknown Station key ${stop.key}`)
      return { kind: "station", stationId: id }
    }
    const stationId =
      stop.source.kind === "existing"
        ? stop.source.stationId
        : keys.get(stop.source.stationKey)
    if (!stationId) throw new Error("Unknown Crossing source")
    const id = `${line.id}-crossing-${i}`
    crossings.push({
      id,
      networkId: line.networkId,
      lineId: line.id,
      sourceStationId: stationId,
      attempt: 0,
      state: { status: "waiting" },
    })
    return { kind: "crossing", crossingId: id, stationId }
  })
  const owned = stops
    .filter((s) => s.kind === "station")
    .map((s) => s.stationId)
  if (
    owned.length !== declared.length ||
    new Set(owned).size !== owned.length ||
    declared.some((id) => !owned.includes(id))
  )
    throw new Error("Route must include every owned Station exactly once")
  return {
    line: {
      ...line,
      stops,
      stationIds: stops
        .filter((s) => s.kind === "station")
        .map((s) => s.stationId),
    },
    crossings,
  }
}

export function startCrossingReview(
  train: Train,
  crossing: Crossing,
  integrationId: string
): Transition<{ train: Train; crossing: Crossing }> {
  if (
    train.state.status !== "docked" ||
    train.state.crossingId !== crossing.id ||
    crossing.state.status !== "waiting" ||
    !crossing.checkpoint
  )
    return reject("invalid_state", "Crossing is not docked for review")
  return accept(
    {
      train: { ...train, state: { ...train.state, status: "reviewing" } },
      crossing: {
        ...crossing,
        attempt: crossing.attempt + 1,
        state: { status: "integrating", integrationId },
      },
    },
    [
      {
        type: "crossing.started",
        crossingId: crossing.id,
        trainId: train.id,
        stationId: crossing.sourceStationId,
      },
    ]
  )
}
export function blockCrossing(
  train: Train,
  crossing: Crossing,
  issues: Issue[]
): Transition<{ train: Train; crossing: Crossing }> {
  if (train.lineId !== crossing.lineId || crossing.state.status === "complete")
    return reject("invalid_state", "Cannot block this Crossing")
  const blocked = blockTrain(train, issues)
  if (!blocked.ok) return blocked
  return accept(
    {
      train: blocked.value,
      crossing: {
        ...crossing,
        state: {
          status: "blocked",
          issues,
          ...(crossing.state.status === "integrating"
            ? { integrationId: crossing.state.integrationId }
            : {}),
        },
      },
    },
    [
      ...blocked.events,
      {
        type: "crossing.blocked",
        crossingId: crossing.id,
        trainId: train.id,
        stationId: crossing.sourceStationId,
      },
      {
        type: "dispatcher.user_attention_requested",
        trainId: train.id,
        stationId: crossing.sourceStationId,
        issues,
      },
    ]
  )
}
