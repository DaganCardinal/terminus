import {
  approveTrainUnload,
  changeUnloadMode,
  selectPlannedUnloadMode,
  type UnloadMode,
} from "@terminus/domain"
import { DispatchError, type DispatcherPorts } from "./dispatcher"
import { StaleWriteError } from "../integrations/network-store"

export async function selectPlanUnloadMode(
  ports: Pick<DispatcherPorts, "store">,
  networkId: string,
  planId: string,
  lineKey: string,
  mode: UnloadMode
) {
  const loaded = await ports.store.dispatchPlan(planId)
  if (!loaded || loaded.networkId !== networkId)
    throw new DispatchError(404, "Unknown plan")
  const selected = selectPlannedUnloadMode(loaded.value, lineKey, mode)
  if (!selected.ok) throw new DispatchError(409, selected.error.message)
  if (selected.events.length) {
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
        throw new DispatchError(
          409,
          "Proposal changed; reload before selecting"
        )
      throw error
    }
  }
  return selected.value
}

/** Permissions are Dispatcher metadata. The Train Workflow applies the gate. */
export async function updateTrainUnload(
  ports: Pick<DispatcherPorts, "store" | "wakeTrain" | "now">,
  trainId: string,
  command: { mode: UnloadMode } | { trainCommit: string }
) {
  const train = await ports.store.train(trainId)
  if (!train) throw new DispatchError(404, "Unknown Train")
  if (train.value.destination?.kind === "junction")
    throw new DispatchError(
      409,
      "Incoming Junction Trains use automatic acceptance; approve the complete feature release"
    )
  const loaded = await ports.store.unloadPolicy(trainId)
  if (!loaded) throw new DispatchError(409, "Train has no unload policy")
  // The D1 trigger closes the concurrent-clearance race for changed writes.
  const active = await ports.store.latestIntegration(trainId)
  if (active && ["cleared", "prepared"].includes(active.status))
    throw new DispatchError(409, "Integration already holds clearance")
  const result =
    "mode" in command
      ? changeUnloadMode(train.value, loaded.value, command.mode)
      : approveTrainUnload(
          train.value,
          loaded.value,
          command.trainCommit,
          ports.now()
        )
  if (!result.ok) throw new DispatchError(409, result.error.message)
  if (result.events.length) {
    try {
      await ports.store.commit(
        train.networkId,
        [
          {
            kind: "unload_policy",
            policy: result.value,
            version: loaded.version,
          },
        ],
        result.events
      )
    } catch (error) {
      if (error instanceof StaleWriteError)
        throw new DispatchError(
          409,
          "Train or unload selection changed; reload and retry"
        )
      if (String(error).includes("unload_policy_closed"))
        throw new DispatchError(
          409,
          "Integration already started; unload selection is closed"
        )
      throw error
    }
  }
  // Periodic reads recover lost wakes; persisting the permission is sufficient.
  await ports.wakeTrain(trainId).catch(() => {})
  return result.value
}
