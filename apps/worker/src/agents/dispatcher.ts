import type { RepositoryHost } from "@terminus/artifacts"
import {
  createLine,
  createTrain,
  placeHold as placeHoldTransition,
  releaseHold as releaseHoldTransition,
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
 * model-driven half, which does not exist yet.
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
