import {
  createJunction,
  createLine,
  createTrain,
  resolveLineRoute,
  validateCrossingTopology,
  hasConcreteRepositoryChange,
  type Junction,
  type DomainEvent,
  type Line,
  type Station,
} from "@terminus/domain"
import {
  createJunctionRequestSchema,
  type CreateJunctionRequest,
} from "@terminus/protocol"
import { DispatchError, orderedPlans, type DispatcherPorts } from "./dispatcher"
import type { Write } from "../integrations/network-store"
import { applied } from "../workflows/transitions"

export interface JunctionDispatchPorts extends DispatcherPorts {
  startJunction(id: string): Promise<void>
  wakeJunction(id: string): Promise<void>
}

/** Validate the entire immutable feature topology before creating repositories. */
export async function layJunction(
  ports: JunctionDispatchPorts,
  networkId: string,
  request: CreateJunctionRequest,
  conductorModel: string
): Promise<Junction> {
  request = createJunctionRequestSchema.parse(request)
  const id = `${networkId}-junction-${request.requestId}`
  const existing = await ports.store.junction(id)
  if (existing) {
    if (existing.value.requestFingerprint !== (await fingerprint(request)))
      throw new DispatchError(
        409,
        "Request identity already belongs to a different feature"
      )
    await ports.startJunction(id)
    for (const trainId of existing.value.incomingTrainIds)
      await ports.startTrain(trainId)
    return existing.value
  }
  const prepared = await prepareJunctionTopology(
    ports,
    networkId,
    request,
    conductorModel
  )
  try {
    await ports.store.commit(networkId, prepared.writes, prepared.events)
  } catch (error) {
    // Concurrent retries may finish their stable repository forks together.
    // The winning atomic launch is the only topology we return or start.
    const winner = await ports.store.junction(id)
    if (!winner) throw error
    if (winner.value.requestFingerprint !== (await fingerprint(request)))
      throw new DispatchError(
        409,
        "Request identity already belongs to a different feature"
      )
    await ports.startJunction(id)
    for (const trainId of winner.value.incomingTrainIds)
      await ports.startTrain(trainId)
    return winner.value
  }
  await ports.startJunction(prepared.junction.id)
  for (const trainId of prepared.junction.incomingTrainIds)
    await ports.startTrain(trainId)
  return prepared.junction
}

export async function prepareJunctionTopology(
  ports: Pick<DispatcherPorts, "store" | "repositories" | "now">,
  networkId: string,
  request: CreateJunctionRequest,
  conductorModel: string,
  identity?: string,
  context?: { lines: Line[]; stations: Station[]; keys: Map<string, string> }
) {
  request = createJunctionRequestSchema.parse(request)
  const id = identity ?? `${networkId}-junction-${request.requestId}`
  const snapshot = await ports.store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  for (const check of request.brief.validation) {
    const project = snapshot.network.validation?.find(
      (c) => c.name === check.name
    )
    if (
      project &&
      JSON.stringify(project.command) !== JSON.stringify(check.command)
    )
      throw new DispatchError(
        400,
        `Feature check ${check.name} conflicts with project configuration`
      )
  }
  const plans = [...request.incoming, request.outgoing]
  const keys = new Map<string, string>(context?.keys)
  const localKeys = new Set<string>()
  for (const [i, plan] of plans.entries())
    for (const [n, station] of plan.stations.entries()) {
      if (localKeys.has(station.key))
        throw new DispatchError(
          400,
          "Station keys must be unique across the feature"
        )
      if (!hasConcreteRepositoryChange(station.manifest))
        throw new DispatchError(
          400,
          "Stations require a concrete repository change"
        )
      localKeys.add(station.key)
      keys.set(station.key, `${id}-l${i}-s${n}`)
    }
  const topology = plans.map((plan, i) => {
    const incoming = i < request.incoming.length
    const made = applied(
      createLine({
        id: `${id}-l${i}`,
        networkId,
        name: plan.name,
        ...(incoming
          ? { destination: { kind: "junction" as const, junctionId: id } }
          : { origin: { kind: "junction" as const, junctionId: id } }),
        stations: orderedPlans(plan.stations, plan.route).map((station) => ({
          id: keys.get(station.key)!,
          name: station.name,
          manifest: {
            ...station.manifest,
            dependencies: station.manifest.dependencies.map(
              (k) => keys.get(k) ?? k
            ),
          },
        })),
      })
    )
    const route = resolveLineRoute(made.value.line, plan.route, keys)
    return { ...made.value, ...route, events: made.events }
  })
  const errors = validateCrossingTopology(
    [
      ...(context?.lines ?? snapshot.lines),
      ...topology
        .map((t) => t.line)
        .filter((l) => !context?.lines.some((v) => v.id === l.id)),
    ],
    [
      ...(context?.stations ?? snapshot.stations),
      ...topology
        .flatMap((t) => t.stations)
        .filter((s) => !context?.stations.some((v) => v.id === s.id)),
    ]
  )
  if (errors.length) throw new DispatchError(400, errors.join("; "))
  for (const item of topology)
    for (const station of item.stations)
      for (const check of station.manifest.expectedEvidence)
        if (!snapshot.network.validation?.some((v) => v.name === check))
          throw new DispatchError(400, `Unknown project validation ${check}`)
  const repo = await ports.repositories.fork({
    sourceRepoId: snapshot.network.terminusRepoId,
    commit: snapshot.network.terminusCommit,
    name: id,
  })
  const outgoing = topology.at(-1)!
  const created = applied(
    createJunction({
      id,
      networkId,
      name: request.name,
      repoId: repo.repoId,
      headCommit: repo.headCommit,
      terminusBaseline: snapshot.network.terminusCommit,
      incomingLineIds: topology.slice(0, -1).map((t) => t.line.id),
      incomingTrainIds: request.incoming.map((_, i) => `${id}-t${i}`),
      outgoingLineId: outgoing.line.id,
      outgoingTrainId: `${id}-outgoing`,
      outgoingUnloadMode: request.outgoing.unloadMode ?? "auto",
      brief: request.brief,
      conductorModel,
      createdAt: ports.now(),
      requestFingerprint: await fingerprint(request),
    })
  )
  const writes: Write[] = [
    { kind: "junction", junction: created.value, version: null },
  ]
  const events: DomainEvent[] = [...created.events]
  for (const [i, t] of topology.entries()) {
    writes.push(
      { kind: "line", line: t.line },
      ...t.stations.map((station): Write => ({
        kind: "station",
        station,
        version: null,
      })),
      ...t.crossings.map((crossing): Write => ({
        kind: "crossing",
        crossing,
        version: null,
      }))
    )
    events.push(...t.events)
    if (i === request.incoming.length) continue
    const trainId = created.value.incomingTrainIds[i]!
    const fork = await ports.repositories.fork({
      sourceRepoId: repo.repoId,
      commit: repo.headCommit,
      name: trainId,
    })
    const train = applied(
      createTrain({
        id: trainId,
        line: t.line,
        repoId: fork.repoId,
        terminusCommit: created.value.terminusBaseline,
      })
    )
    writes.push(
      { kind: "train", train: train.value, version: null },
      {
        kind: "unload_policy",
        policy: { trainId, mode: "auto" },
        version: null,
      }
    )
    events.push(
      ...train.events,
      ...t.crossings.map((c) => ({
        type: "crossing.created" as const,
        crossingId: c.id,
        trainId,
        stationId: c.sourceStationId,
      }))
    )
  }
  const current = await ports.store.network(networkId)
  if (current?.terminusCommit !== created.value.terminusBaseline)
    throw new DispatchError(
      409,
      "Terminus changed before feature launch; request a fresh plan"
    )
  writes.sort(
    (a, b) => (a.kind === "crossing" ? 1 : 0) - (b.kind === "crossing" ? 1 : 0)
  )
  return { junction: created.value, writes, events }
}

async function fingerprint(request: CreateJunctionRequest) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(request))
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
}
