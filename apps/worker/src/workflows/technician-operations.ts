import {
  startRepair,
  submitRepair,
  validateRepair,
  reviewRepair,
  failRepair,
  unmetRequiredChecks,
  repairMatches,
} from "@terminus/domain"
import {
  repairCandidateSchema,
  evidenceSchema,
  conductorVerdictSchema,
} from "@terminus/protocol"
import type { TechnicianPorts } from "../agents/technician"
import { applied } from "./transitions"

export async function prepareTechnician(
  ports: TechnicianPorts,
  id: string
): Promise<void> {
  const loaded = await ports.store.repair(id)
  if (!loaded) throw new Error("Unknown repair")
  if (loaded.value.state.status !== "requested") return
  await assertSources(ports, loaded.value)
  const workspace = await ports.repositories.fork({
    sourceRepoId: loaded.value.source.terminusRepoId,
    commit: loaded.value.source.terminusCommit,
    name: id,
  })
  const started = applied(startRepair(loaded.value, workspace.repoId))
  await ports.store.commit(
    loaded.networkId,
    [
      {
        kind: "technician_repair",
        repair: started.value,
        version: loaded.version,
      },
    ],
    started.events
  )
}

export async function runTechnician(
  ports: TechnicianPorts,
  id: string
): Promise<void> {
  const loaded = await ports.store.repair(id)
  if (!loaded) throw new Error("Unknown repair")
  if (loaded.value.state.status !== "running") return
  await assertSources(ports, loaded.value)
  const result = repairCandidateSchema.parse(
    await ports.runner.run(loaded.value, loaded.value.state.workspaceRepoId)
  )
  const candidate = {
    repoId: result.workspaceRepoId,
    headCommit: result.proposal.headCommit,
  }
  // The harness's summary and claimed evidence never authorize a candidate.
  const snapshot = await ports.repositories.inspectRepair(
    loaded.value,
    candidate
  )
  const submitted = applied(
    submitRepair(loaded.value, {
      ...result,
      ...snapshot,
      proposal: {
        ...result.proposal,
        changedPaths: snapshot.changedPaths,
        diff: snapshot.diff,
        evidence: { checks: [] },
        agent: loaded.value.agent,
      },
    })
  )
  await ports.store.commit(
    loaded.networkId,
    [
      {
        kind: "technician_repair",
        repair: submitted.value,
        version: loaded.version,
      },
    ],
    submitted.events
  )
}

export async function validateTechnician(
  ports: TechnicianPorts,
  id: string
): Promise<void> {
  const loaded = await ports.store.repair(id)
  if (!loaded) throw new Error("Unknown repair")
  if (loaded.value.state.status !== "reviewing") return
  const state = loaded.value.state
  if (state.proposal.evidence.checks.length) return
  const attempt = await ports.store.integration(
    loaded.value.source.integrationId
  )
  if (!attempt) throw new Error("Repair lost its failed integration provenance")
  const evidence = evidenceSchema.parse(
    await ports.validator.validate(
      { repoId: state.workspaceRepoId, headCommit: state.proposal.headCommit },
      attempt.input.validation
    )
  )
  const validated = applied(validateRepair(loaded.value, evidence))
  await ports.store.commit(
    loaded.networkId,
    [
      {
        kind: "technician_repair",
        repair: validated.value,
        version: loaded.version,
      },
    ],
    validated.events
  )
}

export async function reviewTechnician(
  ports: TechnicianPorts,
  id: string
): Promise<void> {
  const loaded = await ports.store.repair(id)
  if (!loaded) throw new Error("Unknown repair")
  if (loaded.value.state.status !== "reviewing") return
  const missing = unmetRequiredChecks(
    loaded.value.state.proposal.evidence,
    loaded.value.expectedChecks
  )
  const review = missing.length
    ? {
        verdict: "return" as const,
        summary: "Project-wide validation did not pass",
        findings: missing.map((check) => `${check.name}: ${check.status}`),
      }
    : conductorVerdictSchema.parse(await ports.reviewer.review(loaded.value))
  const reviewed = applied(
    reviewRepair(loaded.value, { ...review, model: ports.reviewer.model })
  )
  await ports.store.commit(
    loaded.networkId,
    [
      {
        kind: "technician_repair",
        repair: reviewed.value,
        version: loaded.version,
      },
    ],
    reviewed.events
  )
}

export async function failTechnician(
  ports: TechnicianPorts,
  id: string,
  detail: string
): Promise<void> {
  const loaded = await ports.store.repair(id)
  if (
    !loaded ||
    !["requested", "running", "reviewing"].includes(loaded.value.state.status)
  )
    return
  const result = applied(
    loaded.value.state.status === "reviewing"
      ? reviewRepair(loaded.value, {
          model: ports.reviewer.model,
          verdict: "escalate",
          summary: detail,
          findings: ["Technician review needs intervention"],
        })
      : failRepair(loaded.value, detail)
  )
  await ports.store.commit(
    loaded.networkId,
    [
      {
        kind: "technician_repair",
        repair: result.value,
        version: loaded.version,
      },
    ],
    result.events
  )
}

async function assertSources(
  ports: TechnicianPorts,
  repair: import("@terminus/domain").TechnicianRepair
) {
  const train = await ports.store.train(repair.source.trainId)
  const network = await ports.store.network(repair.networkId)
  const conflict = (await ports.store.conflicts(repair.networkId)).find(
    (item) => item.id === repair.conflictId
  )
  if (
    !train ||
    !network ||
    train.value.state.status !== "blocked" ||
    conflict?.status !== "open" ||
    !repairMatches(repair, {
      trainCommit: train.value.headCommit,
      terminusCommit: network.terminusCommit,
    })
  )
    throw new Error("Repair source moved or its conflict is no longer active")
}
