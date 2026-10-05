import {
  approveRepair,
  staleRepair,
  type TechnicianRepair,
} from "@terminus/domain"
import { junctionRepairRequestSchema } from "@terminus/protocol"
import { DispatchError } from "./dispatcher"
import type { TechnicianPorts } from "./technician"
import { applied } from "../workflows/transitions"
import { featureChecks } from "../workflows/junction-operations"
import { defaultValidation } from "../integrations/execution-config"

export async function dispatchJunctionRepair(
  ports: TechnicianPorts,
  id: string,
  body: unknown
): Promise<TechnicianRepair> {
  const request = junctionRepairRequestSchema.parse(body),
    loaded = await ports.store.junction(id)
  if (!loaded) throw new DispatchError(404, "Unknown Junction")
  const j = loaded.value
  if (j.state.status !== "blocked")
    throw new DispatchError(409, "Junction must be blocked before repair")
  if (
    (await ports.store.integrations(j.networkId)).some(
      (a) =>
        a.input.junctionId === id && ["cleared", "prepared"].includes(a.status)
    )
  )
    throw new DispatchError(
      409,
      "Resolve the uncertain promotion before repair"
    )
  const failureId = j.state.integrationId ?? `${id}-feature-${j.attempt}`
  if (request.failureId !== failureId)
    throw new DispatchError(409, "Junction failure changed; reload")
  const attempt = j.state.integrationId
    ? await ports.store.integration(j.state.integrationId)
    : null
  const conflictPaths =
    attempt?.result && !attempt.result.ok
      ? attempt.result.conflictPaths
      : undefined
  const scope = conflictPaths?.length ? conflictPaths : request.scope
  if (
    !scope?.length ||
    scope.some(
      (path) =>
        path.startsWith("/") ||
        path.split("/").some((p) => !p || p === ".." || p === ".") ||
        /[\\*?[\]{}]/.test(path) ||
        [...path].some((c) => c.charCodeAt(0) < 32)
    )
  )
    throw new DispatchError(
      400,
      "Provide a bounded list of repository-relative repair files"
    )
  const active = (await ports.store.repairs(j.networkId)).find(
    (r) =>
      r.source.junctionId === id &&
      ["requested", "running", "reviewing", "ready", "approved"].includes(
        r.state.status
      )
  )
  if (active) {
    if (
      active.conflictId !== failureId ||
      JSON.stringify([...active.scope].sort()) !==
        JSON.stringify([...scope].sort())
    )
      throw new DispatchError(
        409,
        "An existing repair has different failure or scope; inspect its candidate"
      )
    await ports.startRepair(active.id)
    return active
  }
  const snapshot = await ports.store.snapshot(j.networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const feature = !attempt
  const validation = feature
    ? featureChecks(j, snapshot.network.validation ?? defaultValidation)
    : attempt.input.validation
  const repair: TechnicianRepair = {
    id: ports.newId("junction-repair"),
    networkId: j.networkId,
    conflictId: failureId,
    problem: {
      kind: conflictPaths?.length
        ? "conflict"
        : j.state.issues.some((i) => i.kind === "required_checks_failed")
          ? "checks"
          : "review",
      id: failureId,
    },
    validation,
    featureBrief: j.brief,
    source: {
      junctionId: id,
      kind: feature ? "junction_feature" : "junction_input",
      integrationId: failureId,
      trainId: attempt?.input.trainId ?? j.incomingTrainIds[0]!,
      trainRepoId: feature ? j.repoId : attempt!.input.trainRepoId,
      trainCommit: feature ? j.headCommit : attempt!.input.trainCommit,
      trainBaseline: j.terminusBaseline,
      terminusRepoId: j.repoId,
      terminusCommit: j.headCommit,
      acceptedCommits: feature
        ? snapshot.cars
            .filter((c) => j.inputs.some((i) => i.carIds.includes(c.id)))
            .map((c) => c.acceptedCommit)
        : attempt!.input.acceptedCommits,
    },
    scope,
    description:
      request.description ?? j.state.issues.map((i) => i.detail).join("; "),
    manifests: snapshot.cars
      .filter(
        (c) =>
          j.inputs.some((i) => i.carIds.includes(c.id)) ||
          c.trainId === attempt?.input.trainId
      )
      .map((c) => c.manifest),
    expectedChecks: validation.map((c) => c.name),
    agent: ports.runner.config,
    createdAt: ports.now(),
    state: { status: "requested" },
  }
  try {
    await ports.store.commit(
      j.networkId,
      [{ kind: "technician_repair", repair, version: null }],
      [
        {
          type: "technician.dispatched",
          repairId: repair.id,
          trainId: repair.source.trainId,
        },
      ]
    )
  } catch (error) {
    const winner = (await ports.store.repairs(j.networkId)).find(
      (r) =>
        r.source.junctionId === id &&
        ["requested", "running", "reviewing", "ready", "approved"].includes(
          r.state.status
        )
    )
    if (!winner) throw error
    if (
      winner.conflictId !== failureId ||
      JSON.stringify([...winner.scope].sort()) !==
        JSON.stringify([...scope].sort())
    )
      throw new DispatchError(
        409,
        "An existing repair has different failure or scope; inspect its candidate"
      )
    await ports.startRepair(winner.id)
    return winner
  }
  await ports.startRepair(repair.id)
  return repair
}
export async function approveJunctionRepair(
  ports: TechnicianPorts,
  id: string,
  junctionId: string,
  commit: string
): Promise<TechnicianRepair> {
  const loaded = await ports.store.repair(id),
    j = await ports.store.junction(junctionId)
  if (!loaded || !j || loaded.value.source.junctionId !== junctionId)
    throw new DispatchError(404, "Unknown Junction repair")
  if (
    !("proposal" in loaded.value.state) ||
    loaded.value.state.proposal.headCommit !== commit
  )
    throw new DispatchError(
      409,
      "Repair approval is stale; review the exact candidate"
    )
  if (loaded.value.state.status === "integrated") return loaded.value
  if (
    loaded.value.state.status === "approved" &&
    (await ports.store.integrations(j.networkId)).some(
      (a) =>
        a.input.repairId === id &&
        ["cleared", "prepared"].includes(a.status) &&
        a.input.terminusCommit === j.value.headCommit
    )
  )
    return loaded.value
  const train = await ports.store.train(loaded.value.source.trainId)
  const sourceCommit =
    loaded.value.source.kind === "junction_feature"
      ? j.value.headCommit
      : train?.value.headCommit
  if (
    j.value.state.status !== "blocked" ||
    loaded.value.conflictId !==
      (j.value.state.integrationId ??
        `${junctionId}-feature-${j.value.attempt}`) ||
    sourceCommit !== loaded.value.source.trainCommit ||
    j.value.headCommit !== loaded.value.source.terminusCommit
  ) {
    if (["ready", "approved"].includes(loaded.value.state.status)) {
      const stale = applied(staleRepair(loaded.value))
      await ports.store.commit(
        j.networkId,
        [
          {
            kind: "technician_repair",
            repair: stale.value,
            version: loaded.version,
          },
        ],
        stale.events
      )
    }
    throw new DispatchError(
      409,
      "Repair sources changed; dispatch a new candidate"
    )
  }
  if (loaded.value.state.status === "approved") return loaded.value
  const result = approveRepair(loaded.value, {
    trainCommit: sourceCommit,
    terminusCommit: j.value.headCommit,
  })
  if (!result.ok) throw new DispatchError(409, result.error.message)
  try {
    await ports.store.commit(
      j.networkId,
      [
        {
          kind: "technician_repair",
          repair: result.value,
          version: loaded.version,
        },
      ],
      result.events
    )
  } catch (error) {
    const acknowledged = (await ports.store.repair(id))?.value
    if (
      acknowledged &&
      ["approved", "integrated"].includes(acknowledged.state.status) &&
      "proposal" in acknowledged.state &&
      acknowledged.state.proposal.headCommit === commit
    )
      return acknowledged
    throw error
  }
  return result.value
}
