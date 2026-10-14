import { createLine, createTrain, type DomainEvent } from "@terminus/domain"
import {
  PIPELINE_STRESS_PROFILE,
  stressLines,
  stressTask,
  type StressLaunch,
  type NetworkSnapshot,
  type NetworkSummary,
} from "@terminus/protocol"
import type { DispatcherPorts } from "./dispatcher"
import { DispatchError, projectNamespace } from "./dispatcher"
import type { Write } from "../integrations/network-store"
import { defaultValidation } from "../integrations/execution-config"
import { stressBaselineFiles } from "../integrations/stress-baseline"
import { applied } from "../workflows/transitions"

/** Read-only discovery: the immutable manifests and Train baselines identify the run. */
export function stressRun(
  snapshot: NetworkSnapshot,
  mode: StressLaunch["mode"]
): StressLaunch {
  if (snapshot.stations.length !== 10 || snapshot.trains.length !== 10)
    throw new DispatchError(404, "This Network is not a ten-Train stress run")
  let task
  try {
    task = stressTask(snapshot.stations[0]!.manifest)
  } catch {
    throw new DispatchError(404, "This Network is not a stress run")
  }
  const baseline = snapshot.trains[0]!.train.terminusBaseline
  const numbers = new Set<number>()
  for (const station of snapshot.stations) {
    const other = stressTask(station.manifest)
    if (other.runId !== task.runId)
      throw new DispatchError(409, "Mixed stress fixtures")
    numbers.add(other.train)
  }
  if (
    numbers.size !== 10 ||
    snapshot.trains.some(({ train }) => train.terminusBaseline !== baseline)
  )
    throw new DispatchError(409, "Stress topology differs from its fixture")
  return {
    profile: PIPELINE_STRESS_PROFILE,
    runId: task.runId,
    networkId: snapshot.network.id,
    baseline,
    mode,
  }
}

/** Atomic topology and frozen execution, followed by recoverable stable Workflow starts. */
export async function launchStressTest(
  ports: DispatcherPorts,
  request: { requestId: string; networkId?: string },
  mode: StressLaunch["mode"]
): Promise<StressLaunch> {
  const networkId = request.networkId ?? `network-stress-${request.requestId}`
  const existing = await ports.store.snapshot(networkId)
  if (existing?.lines.length) {
    const run = stressRun(existing, mode)
    if (run.runId !== request.requestId)
      throw new DispatchError(409, "Network belongs to another stress run")
    for (const { train } of existing.trains) await ports.startTrain(train.id)
    return run
  }
  if (
    existing &&
    (existing.stations.length ||
      existing.trains.length ||
      existing.cars.length ||
      existing.holds.length ||
      existing.plans.length ||
      existing.conflicts.length ||
      existing.junctions?.length)
  )
    throw new DispatchError(409, "Use an empty Network for a stress run")
  if (request.networkId && !existing)
    throw new DispatchError(404, "Unknown network")
  const network: NetworkSummary = existing?.network ?? {
    id: networkId,
    name: `Stress test · ${request.requestId.slice(0, 8)}`,
    ...(await (async () => {
      const repo = await ports.repositories.createTerminus({
        namespace: projectNamespace(networkId),
        initialFiles: stressBaselineFiles,
      })
      return { terminusRepoId: repo.repoId, terminusCommit: repo.headCommit }
    })()),
    createdAt: ports.now(),
    validation: defaultValidation,
  }
  if (
    ["typecheck", "test", "build"].some(
      (name) => !network.validation?.some((check) => check.name === name)
    )
  )
    throw new DispatchError(
      400,
      "Stress fixture requires typecheck, test and build validation"
    )
  const writes: Write[] = existing ? [] : [{ kind: "network", network }]
  const events: DomainEvent[] = []
  const trainIds: string[] = []
  for (const [i, plan] of stressLines(request.requestId).entries()) {
    const line = createLine({
      id: `stress-${request.requestId}-l${i + 1}`,
      networkId,
      name: `Stress Train ${i + 1}`,
      stations: plan.stations.map((station) => ({
        id: `stress-${request.requestId}-s${i + 1}`,
        name: station.name,
        manifest: station.manifest,
      })),
    })
    if (!line.ok) throw new DispatchError(400, line.error.message)
    const id = `stress-${request.requestId}-t${i + 1}`
    const repo = await ports.repositories.fork({
      sourceRepoId: network.terminusRepoId,
      commit: network.terminusCommit,
      name: id,
    })
    const train = applied(
      createTrain({
        id,
        line: line.value.line,
        repoId: repo.repoId,
        terminusCommit: network.terminusCommit,
      })
    )
    writes.push(
      { kind: "line", line: line.value.line },
      ...line.value.stations.map((station): Write => ({
        kind: "station",
        station,
        version: null,
      })),
      { kind: "train", train: train.value, version: null },
      {
        kind: "unload_policy",
        policy: { trainId: id, mode: "auto" },
        version: null,
      }
    )
    events.push(...line.events, ...train.events)
    trainIds.push(id)
  }
  try {
    await ports.store.commit(networkId, writes, events)
  } catch (error) {
    // A duplicate HTTP request can win the atomic batch; recover its starts.
    const winner = await ports.store.snapshot(networkId)
    if (
      !winner?.lines.length ||
      stressRun(winner, mode).runId !== request.requestId
    )
      throw error
  }
  for (const id of trainIds) await ports.startTrain(id)
  return {
    profile: PIPELINE_STRESS_PROFILE,
    runId: request.requestId,
    networkId,
    baseline: network.terminusCommit,
    mode,
  }
}
