import type { RepositoryHost } from "@terminus/artifacts"
import {
  createLine,
  createTrain,
  evaluateTerminusEntry,
  placeHold as placeHoldTransition,
  releaseHold as releaseHoldTransition,
  resolveConflict as resolveConflictTransition,
  type Hold,
  type HoldId,
  type Line,
  type NetworkId,
  type Station,
  type StationId,
  type Train,
  type TrainId,
} from "@terminus/domain"
import type {
  CreateNetworkRequest,
  LayLineRequest,
  NetworkSummary,
  PlaceHoldRequest,
  IntegrationAttempt,
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
  retryIntegration(integrationId: string): Promise<void>
  newId(prefix: string): string
  now(): string
}

/** A command the Dispatcher refused, with the HTTP status that fits it. */
export class DispatchError extends Error {
  readonly status: 400 | 404 | 409

  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = "DispatchError"
    this.status = status
  }
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
  const id = ports.newId("network")
  const terminus = await ports.repositories.createTerminus({
    name: id,
    sourceUrl: request.sourceUrl,
  })
  const network: NetworkSummary = {
    id,
    name: request.name,
    terminusRepoId: terminus.repoId,
    terminusCommit: terminus.headCommit,
    createdAt: ports.now(),
    validation: request.validation ?? defaultValidation,
  }
  await ports.store.commit(id, [{ kind: "network", network }], [])
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

  const created = createLine({
    id: ports.newId("line"),
    networkId,
    name: request.name,
    stations: request.stations.map((plan) => ({
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
  const { line, stations } = created.value

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
    { kind: "train", train: train.value, version: null },
  ]
  await ports.store.commit(networkId, writes, [
    ...created.events,
    ...train.events,
  ])
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
 * clears the block itself.
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
  await ports.clearTrain(trainId)
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
  const [trains, holds, conflicts] = await Promise.all([
    ports.store.returningTrains(network.id),
    ports.store.holds(network.id),
    ports.store.conflicts(network.id),
  ])
  const eligible = trains.filter(
    ({ value }) =>
      value.state.status === "returning" &&
      value.state.phase === "awaiting_clearance" &&
      evaluateTerminusEntry(value, { holds, conflicts, trainChecks: [] })
        .kind === "clear"
  )
  if (eligible[0]?.value.id !== trainId) return null
  const snapshot = await ports.store.snapshot(network.id)
  const train = loaded.value
  const acceptedCommits = train.carIds.map((id) => {
    const car = snapshot?.cars.find(
      (car) => car.id === id && car.trainId === trainId
    )
    if (!car)
      throw new DispatchError(409, `Train is missing provenance for Car ${id}`)
    return car.acceptedCommit
  })
  return ports.store.claimIntegration({
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
