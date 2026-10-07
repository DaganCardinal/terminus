import {
  acceptJunctionInput,
  abandonJunction,
  blockJunction,
  copyJunctionCars,
  createTrain,
  junctionCars,
  releaseJunction,
  retryJunction,
  readyJunction,
  startJunctionReview,
  unmetRequiredChecks,
  evaluateTerminusEntry,
  rejectApprovedRepair,
  type Junction,
  type Train,
  type JunctionAcceptance,
  type Issue,
} from "@terminus/domain"
import {
  conductorVerdictSchema,
  evidenceSchema,
  type IntegrationInput,
} from "@terminus/protocol"
import type { Conductor } from "@terminus/agent-runtime"
import type { JunctionDispatchPorts } from "../agents/junctions"
import type { IntegrationPorts } from "./integration-operations"
import type { Loaded, Write } from "../integrations/network-store"
import { applied } from "./transitions"
import { defaultValidation } from "../integrations/execution-config"

export interface JunctionPorts extends JunctionDispatchPorts, IntegrationPorts {
  conductor: Conductor
  startIntegration(id: string): Promise<void>
}
const write = (loaded: Loaded<Junction>, junction: Junction): Write => ({
  kind: "junction",
  junction,
  version: loaded.version,
})
async function block(
  ports: JunctionPorts,
  loaded: Loaded<Junction>,
  issues: Issue[],
  integrationId?: string
) {
  const result = applied(blockJunction(loaded.value, issues, integrationId))
  await ports.store.commit(
    loaded.networkId,
    [write(loaded, result.value)],
    result.events
  )
}

/** One durable Junction owner serializes arrivals, acknowledges promotions, and releases the feature. */
/** What the Junction Workflow does after a step. */
export type JunctionMove = "moved" | "wait" | "review" | "finished"

export async function advanceJunction(
  ports: JunctionPorts,
  id: string
): Promise<JunctionMove> {
  const loaded = await ports.store.junction(id)
  if (!loaded) throw new Error("Unknown Junction")
  const j = loaded.value
  const attempts = (await ports.store.integrations(j.networkId)).filter(
    (a) => a.input.purpose === "junction" && a.input.junctionId === id
  )
  const active = attempts.find((a) =>
    ["cleared", "prepared"].includes(a.status)
  )
  // A promotion receipt is consumed before commands, including abandonment.
  if (active?.result?.ok) {
    if (!active.candidate || active.review?.verdict !== "accept")
      throw new Error("Junction promotion has no accepted candidate")
    const snapshot = await ports.store.snapshot(j.networkId)
    if (!snapshot) throw new Error("Unknown network")
    const repair = active.input.repairId
      ? await ports.store.repair(active.input.repairId)
      : null
    let next: Junction
    let events: import("@terminus/domain").DomainEvent[] = []
    const writes: Write[] = []
    if (repair?.value.source.kind === "junction_feature")
      next = {
        ...j,
        headCommit: active.result.mergeCommit,
        acceptance: undefined,
        state: { status: "collecting" },
      }
    else {
      const train = (await ports.store.train(active.input.trainId))?.value
      if (!train || train.headCommit !== active.input.trainCommit)
        throw new Error("Accepted Junction input moved")
      const result = applied(
        acceptJunctionInput(
          j.state.status === "blocked" ? applied(retryJunction(j)).value : j,
          {
            trainId: train.id,
            lineId: train.lineId,
            sourceCommit: train.headCommit,
            integrationId: active.input.id,
            mergeCommit: active.result.mergeCommit,
            carIds: [...train.carIds],
          },
          {
            evidence: active.result.evidence,
            expectedChecks: active.input.validation.map((c) => c.name),
            verdict: active.review.verdict,
          }
        )
      )
      next = result.value
      events = result.events
    }
    if (repair) {
      if (repair.value.state.status !== "approved")
        throw new Error("Junction repair lost approval")
      next = {
        ...next,
        repairIds: [...new Set([...next.repairIds, repair.value.id])],
      }
      writes.push({
        kind: "technician_repair",
        repair: {
          ...repair.value,
          state: {
            ...repair.value.state,
            status: "integrated",
            integrationId: active.input.id,
          },
        },
        version: repair.version,
      })
      events.push({
        type: "technician.integrated",
        repairId: repair.value.id,
        trainId: repair.value.source.trainId,
      })
    }
    await ports.store.commit(
      j.networkId,
      [
        write(loaded, next),
        ...writes,
        { kind: "junction_ack", integrationId: active.input.id },
      ],
      events
    )
    await ports.wakeTrain(active.input.trainId).catch(() => {})
    return "moved"
  }
  const command = await ports.store.junctionCommand(id)
  if (command?.abandon_reason) {
    if (active) {
      if (active.result) return "wait"
      await ports.startIntegration(active.input.id)
      return "wait"
    }
    if (
      (await ports.store.repairs(j.networkId)).some(
        (r) =>
          r.source.junctionId === id &&
          ["requested", "running", "reviewing"].includes(r.state.status)
      )
    )
      return "wait"
    for (const trainId of j.incomingTrainIds) {
      const train = (await ports.store.train(trainId))?.value
      if (train && !["unloaded", "siding"].includes(train.state.status)) {
        if (!(await ports.store.requestSiding(trainId, command.abandon_reason)))
          return "wait"
        await ports.notifyTrainCommand(trainId).catch(() => {})
      }
    }
    const result = applied(abandonJunction(j, command.abandon_reason))
    await ports.store.commit(
      j.networkId,
      [
        write(loaded, result.value),
        { kind: "junction_command_consumed", junctionId: id },
      ],
      result.events
    )
    return "finished"
  }
  if (j.state.status === "released") {
    await ports.startTrain(j.outgoingTrainId)
    return "finished"
  }
  if (j.state.status === "abandoned") return "finished"
  if (active) {
    if (active.result) {
      if (j.state.status !== "blocked") {
        await block(
          ports,
          loaded,
          active.result.ok ? [] : active.result.issues,
          active.input.id
        )
        return "moved"
      }
      return "wait" // Uncertain promotion keeps its reservation until explicit recovery.
    }
    if (j.state.status === "blocked" && command?.retry) {
      const resumed = applied(retryJunction(j))
      await ports.store.commit(
        j.networkId,
        [
          write(loaded, resumed.value),
          { kind: "junction_command_consumed", junctionId: id },
        ],
        resumed.events
      )
      const source = await ports.store.train(active.input.trainId)
      if (
        source?.value.state.status === "blocked" &&
        source.value.state.resume.status === "returning"
      )
        await ports.clearTrain(source.value.id)
      return "moved"
    }
    if (!active.input.repairId) {
      const source = await ports.store.train(active.input.trainId)
      if (source?.value.state.status !== "returning") return "wait"
    }
    await ports.startIntegration(active.input.id)
    return "wait"
  }
  if (j.state.status === "blocked") {
    const repairs = (await ports.store.repairs(j.networkId)).filter(
      (r) => r.source.junctionId === id
    )
    const approved = repairs.find((r) => r.state.status === "approved")
    if (approved) {
      if (approved.source.terminusCommit !== j.headCommit)
        throw new Error("Junction repair is stale")
      const network = await ports.store.network(j.networkId)
      const input: IntegrationInput = {
        purpose: "junction",
        junctionId: id,
        repairId: approved.id,
        id: `${approved.id}-integration-${j.attempt + 1}`,
        networkId: j.networkId,
        trainId: approved.source.trainId,
        trainRepoId: approved.source.trainRepoId,
        trainCommit: approved.source.trainCommit,
        trainBaseline: j.terminusBaseline,
        terminusRepoId: j.repoId,
        terminusCommit: j.headCommit,
        acceptedCommits: approved.source.acceptedCommits,
        validation:
          approved.validation ?? network!.validation ?? defaultValidation,
        conductorModel: j.conductorModel,
      }
      const claimed = await ports.store.claimJunctionIntegration(input)
      if (claimed) {
        // The repair covers the recorded failed gate. The full feature is reviewed again afterward.
        const resumed = applied(retryJunction(j))
        await ports.store.commit(
          j.networkId,
          [write(loaded, resumed.value)],
          resumed.events
        )
        await ports.startIntegration(input.id)
        return "moved"
      }
    }
    if (command?.retry) {
      const result = applied(retryJunction(j))
      await ports.store.commit(
        j.networkId,
        [
          write(loaded, result.value),
          { kind: "junction_command_consumed", junctionId: id },
        ],
        result.events
      )
      if (j.state.integrationId) {
        const failed = await ports.store.integration(j.state.integrationId)
        const source = failed && (await ports.store.train(failed.input.trainId))
        if (
          source?.value.state.status === "blocked" &&
          source.value.state.resume.status === "returning"
        )
          await ports.clearTrain(source.value.id)
      }
      return "moved"
    }
    return "wait"
  }
  const failed = attempts.findLast(
    (a) =>
      a.status === "failed" &&
      !j.inputs.some((i) => i.integrationId === a.input.id) &&
      a.input.id.endsWith(`-${j.attempt}`)
  )
  if (failed?.result && !failed.result.ok) {
    if (failed.result.holds) {
      const train = await ports.store.train(failed.input.trainId)
      const repair = failed.input.repairId
        ? await ports.store.repair(failed.input.repairId)
        : null
      const gateTrain =
        repair?.value.source.kind === "junction_feature"
          ? outgoingGateTrain(j)
          : train?.value
      if (
        !gateTrain ||
        evaluateTerminusEntry(gateTrain, {
          holds: await ports.store.holds(j.networkId),
          conflicts: await ports.store.conflicts(j.networkId),
          trainChecks: [],
        }).kind !== "clear"
      )
        return "wait"
      if (failed.input.repairId) {
        await block(ports, loaded, failed.result.issues, failed.input.id)
        return "moved"
      }
      await ports.store.commit(
        j.networkId,
        [write(loaded, { ...j, attempt: j.attempt + 1 })],
        [{ type: "junction.retried", junctionId: id }]
      )
      return "moved"
    }
    const blocked = applied(
      blockJunction(j, failed.result.issues, failed.input.id)
    )
    const writes: Write[] = [write(loaded, blocked.value)]
    const events = [...blocked.events]
    if (failed.input.repairId) {
      const repair = await ports.store.repair(failed.input.repairId)
      if (repair?.value.state.status === "approved") {
        const rejected = applied(
          rejectApprovedRepair(
            repair.value,
            failed.input.id,
            failed.result.issues.map((i) => i.detail).join("; "),
            failed.result.evidence
          )
        )
        writes.push({
          kind: "technician_repair",
          repair: rejected.value,
          version: repair.version,
        })
        events.push(...rejected.events)
      }
    }
    await ports.store.commit(j.networkId, writes, events)
    await ports.wakeTrain(failed.input.trainId).catch(() => {})
    return "moved"
  }
  for (const trainId of j.incomingTrainIds)
    if (!j.inputs.some((i) => i.trainId === trainId)) {
      const train = (await ports.store.train(trainId))?.value
      if (train?.state.status === "siding") {
        await block(ports, loaded, [
          {
            kind: "dependency_unresolvable",
            detail: `Required Junction member ${trainId} was sided before acceptance`,
          },
        ])
        return "moved"
      }
    }
  if (j.state.status === "ready") {
    if (command?.release_commit)
      return releaseFeature(ports, loaded, command.release_commit)
    return "wait"
  }
  if (j.inputs.length === j.incomingTrainIds.length) {
    if (j.state.status === "collecting") {
      const reviewed = applied(startJunctionReview(j))
      await ports.store.commit(
        j.networkId,
        [write(loaded, reviewed.value)],
        reviewed.events
      )
      return "moved"
    }
    // Feature validation and a sandboxed review take minutes: their own step.
    return "review"
  }
  for (const entry of await ports.store.junctionEntries(id)) {
    if (j.inputs.some((i) => i.trainId === entry.trainId)) continue
    const train = (await ports.store.train(entry.trainId))?.value
    if (
      !train ||
      train.state.status !== "returning" ||
      train.headCommit !== entry.commit
    )
      continue
    const gate = evaluateTerminusEntry(train, {
      holds: await ports.store.holds(j.networkId),
      conflicts: await ports.store.conflicts(j.networkId),
      trainChecks: [],
    })
    if (gate.kind !== "clear") continue
    const snapshot = await ports.store.snapshot(j.networkId)
    if (!snapshot) throw new Error("Unknown network")
    const accepted = train.carIds.map((id) => {
      const c = snapshot.cars.find((c) => c.id === id)
      if (!c) throw new Error("Missing input Car provenance")
      return c.acceptedCommit
    })
    const input: IntegrationInput = {
      purpose: "junction",
      junctionId: id,
      id: `${train.id}-junction-${j.attempt}`,
      networkId: j.networkId,
      trainId: train.id,
      trainRepoId: train.repoId,
      trainCommit: train.headCommit,
      trainBaseline: j.terminusBaseline,
      terminusRepoId: j.repoId,
      terminusCommit: j.headCommit,
      acceptedCommits: accepted,
      validation: snapshot.network.validation ?? defaultValidation,
      conductorModel: j.conductorModel,
    }
    const claimed = await ports.store.claimJunctionIntegration(input)
    if (claimed) {
      await ports.startIntegration(input.id)
      return "moved"
    }
  }
  return "wait"
}

export function featureChecks(
  j: Junction,
  project: { name: string; command: string[] }[]
) {
  const checks = new Map(project.map((c) => [c.name, c]))
  for (const check of j.brief.validation) {
    const existing = checks.get(check.name)
    if (
      existing &&
      JSON.stringify(existing.command) !== JSON.stringify(check.command)
    )
      throw new Error(
        `Feature check ${check.name} conflicts with project configuration`
      )
    checks.set(check.name, check)
  }
  return [...checks.values()]
}
/**
 * Validates the converged feature and records the Conductor's feature review,
 * moving the Junction to `ready` or `blocked`. Does nothing unless every input
 * has arrived and the Junction is reviewing. Safe to repeat.
 */
export async function reviewJunctionFeature(
  ports: JunctionPorts,
  id: string
): Promise<void> {
  const loaded = await ports.store.junction(id)
  if (!loaded) throw new Error("Unknown Junction")
  const j = loaded.value
  if (
    j.state.status !== "reviewing" ||
    j.inputs.length !== j.incomingTrainIds.length
  )
    return
  await reviewFeature(ports, loaded)
}

async function reviewFeature(ports: JunctionPorts, loaded: Loaded<Junction>) {
  const j = loaded.value,
    snapshot = await ports.store.snapshot(j.networkId)
  if (!snapshot) throw new Error("Unknown network")
  const checks = featureChecks(
    j,
    snapshot.network.validation ?? defaultValidation
  )
  const evidence = evidenceSchema.parse(
    await ports.validator.validate(
      { repoId: j.repoId, headCommit: j.headCommit },
      checks
    )
  )
  const inspected = await ports.repositories.inspectIntegration?.(
    {
      purpose: "junction",
      id: j.id,
      trainRepoId: j.repoId,
      trainCommit: j.headCommit,
      trainBaseline: j.terminusBaseline,
      terminusRepoId: j.repoId,
      terminusCommit: j.terminusBaseline,
      acceptedCommits: junctionCars(j, snapshot.cars).map(
        (c) => c.acceptedCommit
      ),
    },
    { repoId: j.repoId, headCommit: j.headCommit }
  )
  if (!inspected || !ports.conductor.reviewJunction)
    throw new Error("Junction feature reviewer is unavailable")
  const failing = unmetRequiredChecks(
    evidence,
    checks.map((c) => c.name)
  )
  const verdict = failing.length
    ? {
        verdict: "return" as const,
        summary: "Feature validation failed",
        findings: failing.map((c) => `${c.name}: ${c.status}`),
      }
    : conductorVerdictSchema.parse(
        await ports.conductor.reviewJunction(
          {
            kind: "junction_feature",
            junctionId: j.id,
            brief: j.brief,
            sourceCommit: j.headCommit,
            targetCommit: j.terminusBaseline,
            candidateCommit: j.headCommit,
            ...inspected,
            evidence,
            sourceCars: junctionCars(j, snapshot.cars),
            receivingCars: [],
            repairIds: j.repairIds,
            ...(await junctionReviewProvenance(ports, j)),
          },
          { repoId: j.repoId, validation: checks }
        )
      )
  const acceptance: JunctionAcceptance = {
    commit: j.headCommit,
    evidence,
    review: {
      ...verdict,
      ...ports.conductor.config,
      model: ports.conductor.model,
    },
    ...inspected,
  }
  if (verdict.verdict !== "accept" || failing.length) {
    const result = applied(
      blockJunction({ ...j, acceptance }, [
        {
          kind: failing.length ? "required_checks_failed" : "review_escalated",
          detail: verdict.summary,
        },
      ])
    )
    await ports.store.commit(
      j.networkId,
      [write(loaded, result.value)],
      result.events
    )
  } else {
    const result = applied(
      readyJunction(
        j,
        acceptance,
        checks.map((c) => c.name)
      )
    )
    await ports.store.commit(
      j.networkId,
      [write(loaded, result.value)],
      result.events
    )
  }
}
function outgoingGateTrain(j: Junction): Train {
  return {
    id: j.outgoingTrainId,
    lineId: j.outgoingLineId,
    repoId: j.repoId,
    terminusBaseline: j.terminusBaseline,
    headCommit: j.headCommit,
    carIds: [],
    state: { status: "ready", at: { kind: "junction", junctionId: j.id } },
  }
}
async function releaseFeature(
  ports: JunctionPorts,
  loaded: Loaded<Junction>,
  commit: string
): Promise<"moved" | "wait"> {
  const j = loaded.value
  if (
    evaluateTerminusEntry(outgoingGateTrain(j), {
      holds: await ports.store.holds(j.networkId),
      conflicts: await ports.store.conflicts(j.networkId),
      trainChecks: [],
    }).kind !== "clear"
  )
    return "wait"
  const released = applied(releaseJunction(j, commit)),
    line = await ports.store.line(j.outgoingLineId),
    snapshot = await ports.store.snapshot(j.networkId)
  if (!line || !snapshot) throw new Error("Missing outgoing topology")
  const repo = await ports.repositories.fork({
    sourceRepoId: j.repoId,
    commit,
    name: j.outgoingTrainId,
  })
  const cars = copyJunctionCars(j, snapshot.cars, ports.now())
  const created = applied(
    createTrain({
      id: j.outgoingTrainId,
      line,
      repoId: repo.repoId,
      terminusCommit: j.terminusBaseline,
      headCommit: commit,
    })
  )
  const train = {
    ...created.value,
    carIds: cars.map((c) => c.id),
    junctionId: j.id,
    integrationIds: j.inputs.map((i) => i.integrationId),
    repairIds: j.repairIds,
  }
  // Repository creation can take time. Recheck hard gates before the atomic release.
  if (
    evaluateTerminusEntry(outgoingGateTrain(j), {
      holds: await ports.store.holds(j.networkId),
      conflicts: await ports.store.conflicts(j.networkId),
      trainChecks: [],
    }).kind !== "clear"
  )
    return "wait"
  await ports.store.commit(
    j.networkId,
    [
      { kind: "train", train, version: null },
      ...cars.map((car): Write => ({ kind: "car", car })),
      {
        kind: "unload_policy",
        policy: { trainId: train.id, mode: j.outgoingUnloadMode },
        version: null,
      },
      write(loaded, released.value),
      { kind: "junction_command_consumed", junctionId: j.id },
    ],
    [...created.events, ...released.events]
  )
  await ports.startTrain(train.id)
  return "moved"
}

export async function failJunction(
  ports: JunctionPorts,
  id: string,
  detail: string
) {
  const loaded = await ports.store.junction(id)
  if (
    !loaded ||
    ["released", "abandoned", "blocked"].includes(loaded.value.state.status)
  )
    return
  const active = (await ports.store.integrations(loaded.networkId)).find(
    (a) =>
      a.input.junctionId === id && ["cleared", "prepared"].includes(a.status)
  )
  if (active?.result?.ok) return // Resume its receipt; never turn a promoted snapshot into failure.
  await block(
    ports,
    loaded,
    [{ kind: "integration_failed", detail }],
    active?.input.id
  )
}

/** Reviews receive durable evidence and actual diffs, not only provenance identities. */
export async function junctionReviewProvenance(
  ports: Pick<JunctionPorts, "store">,
  j: Junction
) {
  const integrations = (await ports.store.integrations(j.networkId)).filter(
    (a) => a.input.junctionId === j.id && a.result?.ok
  )
  const repairs = (await ports.store.repairs(j.networkId)).filter((r) =>
    j.repairIds.includes(r.id)
  )
  return {
    integrationReviews: integrations.map((a) => ({
      id: a.input.id,
      sourceCommit: a.input.trainCommit,
      candidateCommit: a.candidate?.headCommit,
      diff: a.diff,
      evidence: a.evidence,
      review: a.review ?? null,
    })),
    repairs: repairs.map((r) => ({
      id: r.id,
      scope: r.scope,
      description: r.description,
      ...("proposal" in r.state
        ? {
            candidateCommit: r.state.proposal.headCommit,
            diff: r.state.proposal.diff,
            repairDiff: r.state.repairDiff,
            evidence: r.state.proposal.evidence,
            review: "review" in r.state ? r.state.review : undefined,
          }
        : {}),
    })),
  }
}
