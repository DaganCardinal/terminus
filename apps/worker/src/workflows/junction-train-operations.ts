import {
  blockTrain,
  clearForTerminus,
  completeIntegration,
  evaluateTerminusEntry,
  holdTrain,
  releaseTrain,
  type Train,
} from "@terminus/domain"
import type { Loaded } from "../integrations/network-store"
import type { TrainMove, TrainPorts } from "./train-operations"
import { applied } from "./transitions"

/** Called exclusively by the incoming Train Workflow; Junction receipts are authoritative. */
export async function advanceJunctionTrain(
  ports: TrainPorts,
  loaded: Loaded<Train>
): Promise<TrainMove | null> {
  const t = loaded.value
  if (
    t.destination?.kind !== "junction" ||
    [
      "unloaded",
      "siding",
      "ready",
      "in_transit",
      "approaching",
      "docked",
      "reviewing",
    ].includes(t.state.status)
  )
    return null
  if (t.state.status === "held" && t.state.resume.status !== "returning")
    return null
  const j = await ports.store.junction(t.destination.junctionId)
  if (!j || !j.value.incomingTrainIds.includes(t.id))
    throw new Error("Missing Junction membership")
  const receipt = j.value.inputs.find((i) => i.trainId === t.id)
  if (receipt) {
    const attempt = await ports.store.integration(receipt.integrationId)
    if (
      attempt?.status !== "completed" ||
      !attempt.result?.ok ||
      t.headCommit !== receipt.sourceCommit
    )
      throw new Error("Junction unloading has no acknowledged exact promotion")
    // Promotion already occurred. Later holds cannot undo it.
    const integrating: Train = {
      ...t,
      state: { status: "returning", phase: "integrating" },
    }
    const result = applied(
      completeIntegration({
        train: integrating,
        mergeCommit: receipt.mergeCommit,
        evidence: attempt.result.evidence,
        expectedChecks: attempt.input.validation.map((c) => c.name),
        conflicts: [],
      })
    )
    await ports.store.commit(
      loaded.networkId,
      [{ kind: "train", train: result.value, version: loaded.version }],
      result.events
    )
    return { kind: "moved" }
  }
  if (j.value.state.status === "abandoned") {
    await ports.store.requestSiding(t.id, j.value.state.reason)
    return { kind: "moved" }
  }
  if (j.value.state.status === "blocked" && j.value.state.integrationId) {
    const attempt = await ports.store.integration(j.value.state.integrationId)
    if (
      attempt?.input.trainId === t.id &&
      attempt.status === "failed" &&
      attempt.result &&
      !attempt.result.ok &&
      t.state.status !== "blocked"
    ) {
      const result = applied(blockTrain(t, attempt.result.issues))
      await ports.store.commit(
        loaded.networkId,
        [{ kind: "train", train: result.value, version: loaded.version }],
        result.events
      )
      return { kind: "moved" }
    }
  }
  if (t.state.status === "blocked") return null
  const context = {
    holds: await ports.store.holds(loaded.networkId),
    conflicts: await ports.store.conflicts(loaded.networkId),
    trainChecks: [],
  }
  const gate = evaluateTerminusEntry(t, context)
  if (gate.kind !== "clear") {
    const result = applied(
      gate.kind === "hold"
        ? holdTrain(t, gate.reasons)
        : blockTrain(t, gate.issues)
    )
    if (result.events.length)
      await ports.store.commit(
        loaded.networkId,
        [{ kind: "train", train: result.value, version: loaded.version }],
        result.events
      )
    return { kind: gate.kind === "hold" ? "await_wake" : "await_clear" }
  }
  if (t.state.status === "held") {
    const result = applied(releaseTrain(t))
    await ports.store.commit(
      loaded.networkId,
      [{ kind: "train", train: result.value, version: loaded.version }],
      result.events
    )
    return { kind: "moved" }
  }
  await ports.store.requestJunctionEntry(j.value.id, t)
  await ports.wakeJunction?.(j.value.id).catch(() => {})
  const active = (await ports.store.integrations(loaded.networkId)).find(
    (a) =>
      a.input.purpose === "junction" &&
      a.input.trainId === t.id &&
      ["cleared", "prepared"].includes(a.status)
  )
  if (
    active &&
    t.state.status === "returning" &&
    t.state.phase === "awaiting_clearance"
  ) {
    const result = applied(clearForTerminus({ train: t, context }))
    await ports.store.commit(
      loaded.networkId,
      [{ kind: "train", train: result.value, version: loaded.version }],
      result.events
    )
    return { kind: "moved" }
  }
  return { kind: "await_terminus" }
}
