import {
  dispatchTechnician as dispatchRepair,
  approveRepair as approveTransition,
  staleRepair,
  repairMatches,
  type TechnicianRepair,
} from "@terminus/domain"
import type { TechnicianRunner, RepairConductor } from "@terminus/agent-runtime"
import type { DispatcherPorts } from "./dispatcher"
import { DispatchError } from "./dispatcher"
import { applied } from "../workflows/transitions"
import type { IntegrationValidator } from "../integrations/integration-validator"
import { StaleWriteError, type Write } from "../integrations/network-store"

export interface TechnicianPorts extends DispatcherPorts {
  runner: TechnicianRunner
  reviewer: RepairConductor
  validator: IntegrationValidator
  startRepair(repairId: string): Promise<void>
}

/** The Dispatcher deliberately selects an actual failed merge, never a forecast. */
export async function dispatchTechnician(
  ports: TechnicianPorts,
  networkId: string,
  conflictId: string
): Promise<TechnicianRepair> {
  const snapshot = await ports.store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const conflict = snapshot.conflicts.find((item) => item.id === conflictId)
  if (!conflict || conflict.status !== "open")
    throw new DispatchError(409, "Repair requires an open conflict")
  if (conflict.trainIds.length !== 1)
    throw new DispatchError(
      409,
      "This Technician slice handles one Train's failed Terminus merge"
    )
  const train = await ports.store.train(conflict.trainIds[0]!)
  const latest = train && (await ports.store.latestIntegration(train.value.id))
  const attempt = conflict.id.startsWith("conflict-")
    ? await ports.store.integration(conflict.id.slice("conflict-".length))
    : null
  if (
    !train ||
    train.value.state.status !== "blocked" ||
    train.value.state.resume.status !== "returning" ||
    latest?.status !== "failed" ||
    !attempt ||
    attempt.input.trainId !== train.value.id ||
    attempt.status !== "failed" ||
    attempt.result?.ok !== false ||
    !attempt.result.conflictPaths?.length ||
    conflict.id !== `conflict-${attempt.input.id}` ||
    attempt.input.trainCommit !== train.value.headCommit
  )
    throw new DispatchError(
      409,
      "Conflict is not the Train's current failed Terminus merge"
    )
  const existing = snapshot.repairs?.find(
    (repair) =>
      repair.conflictId === conflictId &&
      ["requested", "running", "reviewing", "ready", "approved"].includes(
        repair.state.status
      )
  )
  const writes: Write[] = []
  const events: import("@terminus/domain").DomainEvent[] = []
  if (existing) {
    if (
      repairMatches(existing, {
        trainCommit: train.value.headCommit,
        terminusCommit: snapshot.network.terminusCommit,
      })
    ) {
      if (["requested", "running", "reviewing"].includes(existing.state.status))
        await ports.startRepair(existing.id)
      return existing
    }
    if (
      existing.state.status !== "ready" &&
      existing.state.status !== "approved"
    )
      throw new DispatchError(
        409,
        "A Technician is still working on this conflict"
      )
    const loaded = (await ports.store.repair(existing.id))!
    const stale = applied(staleRepair(loaded.value))
    writes.push({
      kind: "technician_repair",
      repair: stale.value,
      version: loaded.version,
    })
    events.push(...stale.events)
  }
  const { input } = attempt
  const repair = applied(
    dispatchRepair(
      {
        id: ports.newId("repair"),
        networkId,
        conflictId,
        source: {
          integrationId: input.id,
          trainId: input.trainId,
          trainRepoId: input.trainRepoId,
          trainCommit: input.trainCommit,
          trainBaseline: input.trainBaseline,
          terminusRepoId: input.terminusRepoId,
          terminusCommit: snapshot.network.terminusCommit,
          acceptedCommits: input.acceptedCommits,
        },
        scope: conflict.paths,
        description: conflict.description,
        // Include both incoming and previously integrated Cars' contracts and invariants.
        manifests: snapshot.cars
          .filter(
            (car) =>
              train.value.carIds.includes(car.id) ||
              snapshot.trains.some(
                (view) =>
                  view.train.carIds.includes(car.id) &&
                  view.train.state.status === "unloaded"
              )
          )
          .map((car) => car.manifest),
        expectedChecks: input.validation.map((check) => check.name),
        agent: ports.runner.config,
        createdAt: ports.now(),
      },
      conflict
    )
  )
  writes.push({
    kind: "technician_repair",
    repair: repair.value,
    version: null,
  })
  events.push(...repair.events)
  try {
    await ports.store.commit(networkId, writes, events)
  } catch (error) {
    if (
      error instanceof StaleWriteError ||
      String(error).includes(
        "UNIQUE constraint failed: technician_repairs.conflict_id"
      )
    ) {
      const active = (await ports.store.repairs(networkId)).find(
        (item) =>
          item.conflictId === conflictId &&
          ["requested", "running", "reviewing", "ready", "approved"].includes(
            item.state.status
          )
      )
      if (active && repairMatches(active, repair.value.source)) {
        if (["requested", "running", "reviewing"].includes(active.state.status))
          await ports.startRepair(active.id)
        return active
      }
      throw new DispatchError(
        409,
        "Repair changed while dispatching; reload and retry"
      )
    }
    throw error
  }
  await ports.startRepair(repair.value.id)
  return repair.value
}

export async function approveTechnician(
  ports: TechnicianPorts,
  networkId: string,
  repairId: string
): Promise<TechnicianRepair> {
  const loaded = await ports.store.repair(repairId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown repair")
  if (loaded.value.state.status === "integrated") return loaded.value
  const train = await ports.store.train(loaded.value.source.trainId)
  const network = await ports.store.network(networkId)
  const conflict = (await ports.store.conflicts(networkId)).find(
    (item) => item.id === loaded.value.conflictId
  )
  if (
    loaded.value.state.status === "approved" &&
    train &&
    train.value.state.status !== "blocked"
  )
    return loaded.value
  const latest = await ports.store.latestIntegration(
    loaded.value.source.trainId
  )
  if (loaded.value.state.status === "approved" && latest?.status !== "failed")
    throw new DispatchError(
      409,
      "Integration needs recovery before this approval can clear the Train"
    )
  if (
    !train ||
    !network ||
    conflict?.status !== "open" ||
    train.value.state.status !== "blocked" ||
    train.value.state.resume.status !== "returning"
  )
    throw new DispatchError(
      409,
      "Train is no longer blocked on this integration conflict"
    )
  const heads = {
    trainCommit: train.value.headCommit,
    terminusCommit: network.terminusCommit,
  }
  if (!repairMatches(loaded.value, heads))
    throw new DispatchError(
      409,
      "Repair is stale; dispatch a fresh Technician against current Terminus"
    )
  let repair = loaded.value
  if (repair.state.status !== "approved") {
    const result = approveTransition(repair, heads)
    if (!result.ok) throw new DispatchError(409, result.error.message)
    repair = result.value
    try {
      await ports.store.commit(
        networkId,
        [{ kind: "technician_repair", repair, version: loaded.version }],
        result.events
      )
    } catch (error) {
      if (!(error instanceof StaleWriteError)) throw error
      const current = (await ports.store.repair(repairId))?.value
      if (
        current?.state.status !== "approved" ||
        !repairMatches(current, heads)
      )
        throw new DispatchError(
          409,
          "Repair sources or approval changed; reload and retry"
        )
      repair = current
    }
  }
  // Approval is durable before notifying; repeating it safely retries a lost wakeup.
  await ports.clearTrain(repair.source.trainId)
  return repair
}
