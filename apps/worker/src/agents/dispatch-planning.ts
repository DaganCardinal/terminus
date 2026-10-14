import {
  createDispatchPlan,
  cancelDispatchPlan,
  finishDispatchCancellation,
  requestPlanLaunch,
  selectBaselineFix,
  type BaselineFixSelection,
  type DispatchPlan,
  type PlanningContext,
} from "@terminus/domain"
import type { DispatchPlanner } from "@terminus/agent-runtime"
import {
  lineIdentities,
  type CreateDispatchPlanRequest,
  type NetworkSnapshot,
} from "@terminus/protocol"
import { DispatchError, type DispatcherPorts } from "./dispatcher"
import { StaleWriteError } from "../integrations/network-store"
import { applied } from "../workflows/transitions"
import { defaultValidation } from "../integrations/execution-config"
import type { DispatchActivityStore } from "../integrations/dispatch-activity"

export interface DispatchPlanningPorts extends Pick<
  DispatcherPorts,
  "store" | "repositories" | "startTrain" | "now"
> {
  startJunction?(id: string): Promise<void>
  planner: DispatchPlanner
  activity?: DispatchActivityStore
  startPlanning(planId: string): Promise<void>
  wakePlan(planId: string): Promise<void>
  retryPlan(planId: string): Promise<void>
  stopPlan(planId: string): Promise<void>
}

/** Existing Lines still own unintegrated code, even when individual Stations are complete. */
export function planningContext(snapshot: NetworkSnapshot): PlanningContext {
  // Finished as the map draws it: Lines joined by a Crossing or Junction
  // finish together, so work collected in an unreleased Junction stays live.
  const identities = lineIdentities(snapshot)
  const junctions = snapshot.junctions ?? []
  const outcome = (line: NetworkSnapshot["lines"][number]) => {
    const junction = junctions.find(
      (j) =>
        j.id ===
        (line.destination?.kind === "junction"
          ? line.destination.junctionId
          : line.origin?.kind === "junction"
            ? line.origin.junctionId
            : undefined)
    )
    return junction?.state.status !== "abandoned" &&
      snapshot.trains.some(
        ({ train }) =>
          train.lineId === line.id && train.state.status === "unloaded"
      )
      ? ("integrated" as const)
      : ("abandoned" as const)
  }
  const finishedLines = snapshot.lines
    .filter((line) => identities.get(line.id)?.live === false)
    .sort((a, b) =>
      identities
        .get(b.id)!
        .finishedAt!.localeCompare(identities.get(a.id)!.finishedAt!)
    )
    .map((line) => ({ lineId: line.id, outcome: outcome(line) }))
  return {
    finishedLines,
    junctions: snapshot.junctions ?? [],
    lines: snapshot.lines,
    stations: snapshot.stations,
    crossings: snapshot.crossings ?? [],
    projectChecks: snapshot.network.validation ?? defaultValidation,
    // Live as the map draws it, except Lines whose own work already unloaded
    // into Terminus: a live receiver keeps its Crossing source live, but that
    // source's code is in the baseline and must not forecast collisions.
    activeLines: snapshot.lines
      .filter(
        (line) =>
          identities.get(line.id)?.live !== false &&
          !(
            line.destination?.kind !== "junction" &&
            snapshot.trains.some(
              ({ train }) =>
                train.lineId === line.id && train.state.status === "unloaded"
            )
          )
      )
      .map((line) => ({
        name: line.name,
        manifests: snapshot.stations
          .filter((station) => station.lineId === line.id)
          .map((s) => s.manifest),
      })),
  }
}

export async function proposeDispatchPlan(
  ports: DispatchPlanningPorts,
  networkId: string,
  request: CreateDispatchPlanRequest
): Promise<DispatchPlan> {
  const network = await ports.store.network(networkId)
  if (!network) throw new DispatchError(404, "Unknown network")
  const id = `dispatch-${request.requestId.replaceAll("-", "")}`
  const existing = await ports.store.dispatchPlan(id)
  if (existing) {
    if (
      existing.networkId !== networkId ||
      existing.value.goal !== request.goal ||
      !!existing.value.checkBaseline !== !!request.checkBaseline
    )
      throw new DispatchError(
        409,
        "Request identity already belongs to a different goal or network"
      )
    if (existing.value.state.status === "planning")
      await ports.startPlanning(id)
    return existing.value
  }
  const created = applied(
    createDispatchPlan({
      id,
      networkId,
      goal: request.goal,
      terminusCommit: network.terminusCommit,
      model: ports.planner.model,
      ...(ports.planner.config ? { agent: ports.planner.config } : {}),
      createdAt: ports.now(),
      ...(request.checkBaseline ? { checkBaseline: true } : {}),
    })
  )
  try {
    await ports.store.commit(
      networkId,
      [{ kind: "dispatch_plan", plan: created.value, version: null }],
      created.events
    )
  } catch (error) {
    // A concurrent retry of the same HTTP submission may have won the insert.
    const winner = await ports.store.dispatchPlan(id)
    if (!winner) throw error
    return proposeDispatchPlan(ports, networkId, request)
  }
  await ports.startPlanning(id)
  return created.value
}

export async function launchPlannedLines(
  ports: DispatchPlanningPorts,
  networkId: string,
  planId: string
): Promise<DispatchPlan> {
  const loaded = await ports.store.dispatchPlan(planId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown plan")
  const plan = loaded.value
  if (["launching", "starting", "launched"].includes(plan.state.status)) {
    if (plan.state.status !== "launched") await ports.wakePlan(planId)
    return plan
  }
  const snapshot = await ports.store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const requested = requestPlanLaunch(
    plan,
    snapshot.network.terminusCommit,
    planningContext(snapshot)
  )
  if (!requested.ok) throw new DispatchError(409, requested.error.message)
  try {
    await ports.store.commit(
      networkId,
      [
        {
          kind: "dispatch_plan",
          plan: requested.value,
          version: loaded.version,
        },
      ],
      requested.events
    )
  } catch (error) {
    if (error instanceof StaleWriteError)
      return launchPlannedLines(ports, networkId, planId)
    if (String(error).includes("stale_plan"))
      throw new DispatchError(
        409,
        "Terminus changed; request a fresh plan before launching"
      )
    throw error
  }
  await ports.wakePlan(planId)
  return requested.value
}

/** Persist cancellation before stopping resources, so late results and retries cannot revive it. */
export async function stopDispatchPlan(
  ports: Pick<DispatchPlanningPorts, "store" | "stopPlan">,
  networkId: string,
  planId: string
): Promise<DispatchPlan> {
  const loaded = await ports.store.dispatchPlan(planId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown plan")
  const cancelled = cancelDispatchPlan(loaded.value)
  if (!cancelled.ok) throw new DispatchError(409, cancelled.error.message)
  if (cancelled.events.length) {
    try {
      await ports.store.commit(
        networkId,
        [
          {
            kind: "dispatch_plan",
            plan: cancelled.value,
            version: loaded.version,
          },
        ],
        cancelled.events
      )
    } catch (error) {
      if (error instanceof StaleWriteError)
        return stopDispatchPlan(ports, networkId, planId)
      throw error
    }
  }
  // Repeating Stop retries cleanup even when the durable cancellation already succeeded.
  await ports.stopPlan(planId)
  const current = (await ports.store.dispatchPlan(planId))!
  const finished = applied(finishDispatchCancellation(current.value))
  if (finished.events.length) {
    try {
      await ports.store.commit(
        networkId,
        [
          {
            kind: "dispatch_plan",
            plan: finished.value,
            version: current.version,
          },
        ],
        finished.events
      )
    } catch (error) {
      if (error instanceof StaleWriteError)
        return stopDispatchPlan(ports, networkId, planId)
      throw error
    }
  }
  return finished.value
}

export async function retryDispatchPlan(
  ports: DispatchPlanningPorts,
  networkId: string,
  planId: string
): Promise<void> {
  const loaded = await ports.store.dispatchPlan(planId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown plan")
  if (
    loaded.value.state.status === "failed" ||
    loaded.value.state.status === "launched"
  )
    throw new DispatchError(
      409,
      "Plan finished; request a fresh plan for new work"
    )
  await ports.retryPlan(planId)
}

/** Includes or rejects a proposal's suggested baseline fix before launch. */
export async function selectPlanBaselineFix(
  ports: Pick<DispatchPlanningPorts, "store">,
  networkId: string,
  planId: string,
  selection: BaselineFixSelection
): Promise<DispatchPlan> {
  const loaded = await ports.store.dispatchPlan(planId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown plan")
  const snapshot = await ports.store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const selected = selectBaselineFix(
    loaded.value,
    selection,
    planningContext(snapshot)
  )
  if (!selected.ok) throw new DispatchError(409, selected.error.message)
  if (!selected.events.length) return selected.value
  try {
    await ports.store.commit(
      networkId,
      [
        {
          kind: "dispatch_plan",
          plan: selected.value,
          version: loaded.version,
        },
      ],
      selected.events
    )
  } catch (error) {
    if (error instanceof StaleWriteError)
      throw new DispatchError(409, "Proposal changed; reload before selecting")
    throw error
  }
  return selected.value
}
