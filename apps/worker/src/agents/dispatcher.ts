import type { RepositoryHost } from "@terminus/artifacts"
import {
  resolveLineRoute,
  validateCrossingTopology,
  conflictsForRepair,
  repairMatches,
  createLine,
  createTrain,
  evaluateTerminusEntry,
  openConflictsFor,
  placeHold as placeHoldTransition,
  releaseHold as releaseHoldTransition,
  resolveConflict as resolveConflictTransition,
  requestStationRemoval,
  type Hold,
  type HoldId,
  type Line,
  type NetworkId,
  type Station,
  type StationId,
  type Train,
  type TrainId,
  type DomainEvent,
} from "@terminus/domain"
import type {
  CreateNetworkRequest,
  LayLineRequest,
  NetworkSummary,
  PlaceHoldRequest,
  IntegrationAttempt,
  RemoveStationRequest,
} from "@terminus/protocol"
import type { NetworkStore, Write } from "../integrations/network-store"
import { defaultValidation } from "../integrations/execution-config"
import { applied } from "../workflows/transitions"

export interface DispatcherPorts {
  store: NetworkStore
  repositories: RepositoryHost
  startTrain(trainId: TrainId): Promise<void>
  wakeTrain(trainId: TrainId): Promise<void>
  clearTrain(trainId: TrainId): Promise<void>
  notifyTrainCommand(trainId: TrainId): Promise<void>
  retryIntegration(integrationId: string): Promise<void>
  newId(prefix: string): string
  now(): string
}

/** A command the Dispatcher refused, with the HTTP status that fits it. */
export class DispatchError extends Error {
  readonly status: 400 | 404 | 409 | 503
  readonly details: unknown

  constructor(
    status: 400 | 404 | 409 | 503,
    message: string,
    details?: unknown
  ) {
    super(message)
    this.name = "DispatchError"
    this.status = status
    this.details = details
  }
}

/** Every repository a Network uses lives in its own Artifacts namespace. */
export function projectNamespace(networkId: NetworkId): string {
  return `terminus-${networkId}`
}

/**
 * An imported project's identity: the same repository however its URL is
 * spelled, ignoring host case, trailing slashes and a `.git` suffix.
 */
export function projectSource(sourceUrl: string): string {
  const url = new URL(sourceUrl)
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  return `${url.protocol}//${url.host.toLowerCase()}${path}`
}

function projectExists(network: NetworkSummary): DispatchError {
  return new DispatchError(
    409,
    `This project already has a network: ${network.name}`,
    { networkId: network.id }
  )
}

/** The deterministic Dispatcher forwards exhausted Station retries, and the
 * Engineer stopping a revision loop early, to the user.
 * These events join the Train's atomic state batch, even with no UI connected. */
export function stationRetryUserAlert(
  train: Train,
  station: Station
): DomainEvent[] {
  if (train.state.status !== "blocked" || station.state.status !== "blocked")
    return []
  const issues = train.state.issues.filter(
    (issue) =>
      issue.kind === "station_retries_exhausted" ||
      issue.kind === "engineer_escalated"
  )
  return issues.length
    ? [
        {
          type: "dispatcher.user_attention_requested",
          trainId: train.id,
          stationId: station.id,
          issues,
        },
      ]
    : []
}

/**
 * The deterministic half of the Dispatcher: it applies network commands as
 * domain transitions and persists them. Planning and judgement belong to the
 * model-driven half, whose proposals are applied by the Dispatch Workflow.
 */
export async function createNetwork(
  ports: DispatcherPorts,
  request: CreateNetworkRequest
): Promise<NetworkSummary> {
  // One Network per Project: importing a project a second time would create
  // a second, diverging canonical Terminus.
  const source = request.sourceUrl && projectSource(request.sourceUrl)
  if (source) {
    const existing = await ports.store.networkForProject(source)
    if (existing) throw projectExists(existing)
  }
  const id = ports.newId("network")
  const terminus = await ports.repositories.createTerminus({
    namespace: projectNamespace(id),
    sourceUrl: request.sourceUrl,
  })
  const network: NetworkSummary = {
    id,
    name: request.name,
    terminusRepoId: terminus.repoId,
    terminusCommit: terminus.headCommit,
    createdAt: ports.now(),
    validation: request.validation ?? defaultValidation,
    ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
  }
  try {
    await ports.store.commit(
      id,
      [
        {
          kind: "network",
          network,
          ...(source ? { projectSource: source } : {}),
        },
      ],
      []
    )
  } catch (error) {
    // A concurrent import of the same project won the unique index.
    const existing = source && (await ports.store.networkForProject(source))
    if (existing) throw projectExists(existing)
    throw error
  }
  return network
}

/**
 * Lays a Line with its Stations, creates its Train at the depot, and starts
 * the Train's Workflow.
 */
export async function layLine(
  ports: DispatcherPorts,
  networkId: NetworkId,
  request: LayLineRequest
): Promise<{ line: Line; stations: Station[]; train: Train }> {
  const network = await ports.store.network(networkId)
  if (!network) throw new DispatchError(404, `Unknown network ${networkId}`)

  const ids = new Map<string, StationId>()
  for (const plan of request.stations) {
    if (ids.has(plan.key)) {
      throw new DispatchError(400, `Station key ${plan.key} appears twice`)
    }
    ids.set(plan.key, ports.newId("station"))
  }

  const external = request.stations
    .flatMap((plan) => plan.manifest.dependencies)
    .filter((dependency) => !ids.has(dependency))
  const known = await ports.store.stationStatuses(external)
  const unknown = external.filter((id) => !(id in known))
  if (unknown.length > 0) {
    throw new DispatchError(400, `Unknown dependencies: ${unknown.join(", ")}`)
  }
  for (const id of external) {
    const dependency = await ports.store.station(id)
    if (
      dependency?.networkId !== networkId ||
      dependency.value.state.status === "cancelled" ||
      dependency.value.removalRequest
    )
      throw new DispatchError(
        409,
        `Dependency ${id} is unavailable or being removed`
      )
  }

  const created = createLine({
    id: ports.newId("line"),
    networkId,
    name: request.name,
    stations: orderedPlans(request.stations, request.route).map((plan) => ({
      id: ids.get(plan.key)!,
      name: plan.name,
      manifest: {
        ...plan.manifest,
        dependencies: plan.manifest.dependencies.map(
          (dependency) => ids.get(dependency) ?? dependency
        ),
      },
    })),
  })
  if (!created.ok) throw new DispatchError(400, created.error.message)
  const stations = created.value.stations
  let resolved: ReturnType<typeof resolveLineRoute>
  try {
    resolved = resolveLineRoute(created.value.line, request.route, ids)
  } catch (error) {
    throw new DispatchError(400, String(error))
  }
  const { line, crossings } = resolved
  const snapshot = await ports.store.snapshot(networkId)
  const errors = validateCrossingTopology(
    [...(snapshot?.lines ?? []), line],
    [...(snapshot?.stations ?? []), ...stations]
  )
  if (errors.length) throw new DispatchError(400, errors.join("; "))

  const trainId = ports.newId("train")
  const repo = await ports.repositories.fork({
    sourceRepoId: network.terminusRepoId,
    commit: network.terminusCommit,
    name: trainId,
  })
  const train = applied(
    createTrain({
      id: trainId,
      line,
      repoId: repo.repoId,
      terminusCommit: network.terminusCommit,
    })
  )

  const writes: Write[] = [
    { kind: "line", line },
    ...stations.map((station): Write => ({
      kind: "station",
      station,
      version: null,
    })),
    ...crossings.map((crossing): Write => ({
      kind: "crossing",
      crossing,
      version: null,
    })),
    { kind: "train", train: train.value, version: null },
    {
      kind: "unload_policy",
      policy: { trainId, mode: request.unloadMode ?? "auto" },
      version: null,
    },
  ]
  try {
    await ports.store.commit(networkId, writes, [
      ...created.events,
      ...crossings.map((c) => ({
        type: "crossing.created" as const,
        crossingId: c.id,
        trainId,
        stationId: c.sourceStationId,
      })),
      ...train.events,
    ])
  } catch (error) {
    if (String(error).includes("station_dependency_unavailable"))
      throw new DispatchError(
        409,
        "A dependency was removed while laying the Line; revise the dependencies"
      )
    throw error
  }
  await ports.startTrain(trainId)
  return { line, stations, train: train.value }
}

/** Places a hold. It takes effect at each affected Train's next gate. */
export async function placeHold(
  ports: DispatcherPorts,
  networkId: NetworkId,
  request: PlaceHoldRequest
): Promise<Hold> {
  if (!(await ports.store.network(networkId))) {
    throw new DispatchError(404, `Unknown network ${networkId}`)
  }
  const placed = placeHoldTransition({ id: ports.newId("hold"), ...request })
  if (!placed.ok) throw new DispatchError(400, placed.error.message)
  await ports.store.commit(
    networkId,
    [{ kind: "hold", hold: placed.value }],
    placed.events
  )
  return placed.value
}

/** Releases a hold and wakes held Trains so they check their gates again. */
export async function releaseHold(
  ports: DispatcherPorts,
  networkId: NetworkId,
  holdId: HoldId
): Promise<void> {
  const holds = await ports.store.holds(networkId)
  const hold = holds.find((existing) => existing.id === holdId)
  if (!hold) throw new DispatchError(404, `Unknown hold ${holdId}`)
  const released = applied(releaseHoldTransition(hold, holds))
  await ports.store.commit(
    networkId,
    [{ kind: "hold_removed", holdId }],
    released.events
  )
  const trains = await ports.store.trains(networkId)
  await Promise.allSettled(
    trains
      .filter((train) => train.value.state.status === "held")
      .map((train) => ports.wakeTrain(train.value.id))
  )
}

/**
 * Tells a blocked Train its issue has been dealt with. The Train's Workflow
 * clears the block itself. An open conflict at Terminus is dealt with only by
 * a Technician repair or by resolving the conflict, so clearing would just
 * retry the same merge.
 */
export async function clearTrain(
  ports: DispatcherPorts,
  trainId: TrainId
): Promise<void> {
  const train = await ports.store.train(trainId)
  if (!train) throw new DispatchError(404, `Unknown Train ${trainId}`)
  if (train.value.state.status !== "blocked") {
    throw new DispatchError(409, `Train ${trainId} is not blocked`)
  }
  if (
    openConflictsFor(trainId, await ports.store.conflicts(train.networkId))
      .length
  ) {
    throw new DispatchError(
      409,
      `Train ${trainId} has an open conflict at Terminus; dispatch a Technician to repair it`
    )
  }
  await ports.clearTrain(trainId)
}

/** Persist the request first; only the Train Workflow applies the cancellation. */
export async function removeStation(
  ports: DispatcherPorts,
  networkId: string,
  stationId: string,
  request: RemoveStationRequest
): Promise<void> {
  const station = await ports.store.station(stationId)
  if (!station || station.networkId !== networkId)
    throw new DispatchError(404, "Unknown Station")
  if (station.value.state.status === "cancelled") return
  const line = await ports.store.line(station.value.lineId)
  const train = (await ports.store.trains(networkId)).find(
    (t) => t.value.lineId === station.value.lineId
  )
  if (!line || !train) throw new DispatchError(404, "Station has no Line Train")
  const trains = await ports.store.trains(networkId)
  if (
    (await ports.store.crossings(networkId)).some(
      (c) =>
        c.sourceStationId === stationId &&
        c.state.status !== "complete" &&
        trains.some(
          (t) =>
            t.value.lineId === c.lineId && t.value.state.status !== "siding"
        )
    )
  )
    throw new DispatchError(409, "Unfinished Crossings depend on this Station")
  const requested = requestStationRemoval({
    train: train.value,
    line,
    station: station.value,
    stations: (await ports.store.stations(networkId)).map((s) => s.value),
    reason: request.reason,
  })
  if (!requested.ok) throw new DispatchError(409, requested.error.message)
  if (requested.events.length)
    await ports.store.commit(
      networkId,
      [{ kind: "station", station: requested.value, version: station.version }],
      requested.events
    )
  // Best effort: periodic gate reads recover a lost wakeup from the durable request.
  await ports.notifyTrainCommand(train.value.id).catch(() => {})
}

/**
 * Deterministic Dispatcher entry control. Oldest eligible return goes first;
 * D1 enforces exclusive clearance even if two Train Workflows ask together.
 * This function never writes Train state.
 */
export async function requestTerminusClearance(
  ports: Pick<DispatcherPorts, "store" | "newId">,
  trainId: TrainId
): Promise<IntegrationAttempt | null> {
  const loaded = await ports.store.train(trainId)
  if (!loaded) throw new DispatchError(404, `Unknown Train ${trainId}`)
  if (
    loaded.value.destination?.kind === "junction" ||
    loaded.value.state.status !== "returning" ||
    loaded.value.state.phase !== "awaiting_clearance"
  )
    throw new DispatchError(409, "Train is not awaiting Terminus clearance")
  const previous = await ports.store.latestIntegration(trainId)
  if (previous && previous.status !== "failed") {
    if (previous.input.trainCommit !== loaded.value.headCommit)
      throw new DispatchError(
        409,
        "Train changed after its integration clearance"
      )
    return previous
  }
  const network = await ports.store.network(loaded.networkId)
  if (!network) throw new DispatchError(404, "Unknown network")
  // The claim below would fail anyway; waiting Trains ask every minute, so
  // skip ranking the queue while another promotion holds the reservation.
  if (await ports.store.hasActiveIntegration(network.terminusRepoId))
    return null
  const [trains, holds, conflicts] = await Promise.all([
    ports.store.returningTrains(network.id),
    ports.store.holds(network.id),
    ports.store.conflicts(network.id),
  ])
  const repairs = await ports.store.repairs(network.id)
  const repairFor = (train: Train) =>
    repairs.find(
      (repair) =>
        repair.state.status === "approved" &&
        repair.source.trainId === train.id &&
        repairMatches(repair, {
          trainCommit: train.headCommit,
          terminusCommit: network.terminusCommit,
        })
    ) ?? null
  const policies = await ports.store.unloadPolicies(network.id)
  const eligible = trains.filter(
    ({ value }) =>
      value.destination?.kind !== "junction" &&
      value.state.status === "returning" &&
      value.state.phase === "awaiting_clearance" &&
      evaluateTerminusEntry(value, {
        unloadPolicy: policies.find((policy) => policy.trainId === value.id),
        holds,
        conflicts: conflictsForRepair(conflicts, repairFor(value), {
          trainCommit: value.headCommit,
          terminusCommit: network.terminusCommit,
        }),
        trainChecks: [],
      }).kind === "clear"
  )
  if (eligible[0]?.value.id !== trainId) return null
  const cars = await ports.store.trainCars(trainId)
  const train = loaded.value
  const acceptedCommits = train.carIds.map((id) => {
    const car = cars.find((car) => car.id === id && car.trainId === trainId)
    if (!car)
      throw new DispatchError(409, `Train is missing provenance for Car ${id}`)
    return car.acceptedCommit
  })
  return ports.store.claimIntegration({
    ...(repairFor(train) ? { repairId: repairFor(train)!.id } : {}),
    id: ports.newId("integration"),
    networkId: network.id,
    trainId,
    trainRepoId: train.repoId,
    trainCommit: train.headCommit,
    trainBaseline: train.terminusBaseline,
    terminusRepoId: network.terminusRepoId,
    terminusCommit: network.terminusCommit,
    acceptedCommits,
    validation: network.validation ?? defaultValidation,
  })
}

export async function resolveConflict(
  ports: DispatcherPorts,
  networkId: string,
  conflictId: string
): Promise<void> {
  const conflict = (await ports.store.conflicts(networkId)).find(
    (item) => item.id === conflictId
  )
  if (!conflict) throw new DispatchError(404, "Unknown conflict")
  if (conflict.status === "resolved") return
  if (
    (await ports.store.repairs(networkId)).some(
      (repair) =>
        repair.conflictId === conflictId &&
        ["requested", "running", "reviewing", "ready", "approved"].includes(
          repair.state.status
        )
    )
  )
    throw new DispatchError(
      409,
      "An active Technician repair resolves this conflict only after promotion"
    )
  const resolved = applied(resolveConflictTransition(conflict))
  await ports.store.commit(
    networkId,
    [{ kind: "conflict", conflict: resolved.value }],
    resolved.events
  )
}

/** Explicit recovery for an errored attempt whose canonical write is uncertain. */
export async function retryIntegration(
  ports: DispatcherPorts,
  integrationId: string
): Promise<void> {
  const attempt = await ports.store.integration(integrationId)
  if (!attempt) throw new DispatchError(404, "Unknown integration attempt")
  if (attempt.status === "completed" || attempt.status === "failed")
    throw new DispatchError(
      409,
      "Attempt already finished; clear a blocked Train to start a new attempt"
    )
  await ports.retryIntegration(integrationId)
}

export function orderedPlans<T extends { key: string }>(
  stations: T[],
  route: import("@terminus/domain").PlannedStop[] | undefined
): T[] {
  if (!route) return stations
  const keys = route.filter((s) => s.kind === "station").map((s) => s.key)
  if (
    keys.length !== stations.length ||
    new Set(keys).size !== keys.length ||
    stations.some((s) => !keys.includes(s.key))
  )
    throw new DispatchError(
      400,
      "Route must include each owned Station exactly once"
    )
  return keys.map((key) => stations.find((s) => s.key === key)!)
}
