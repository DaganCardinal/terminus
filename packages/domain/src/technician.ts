import type { Proposal } from "./station"
import type { AgentConfig } from "./car"
import type { WorkManifest } from "./manifest"
import type { Conflict } from "./conflict"
import { unmetRequiredChecks } from "./evidence"
import { accept, reject, type Transition } from "./transition"

export interface RepairSource {
  junctionId?: string
  kind?: "junction_input" | "junction_feature"
  integrationId: string
  trainId: string
  trainRepoId: string
  trainCommit: string
  trainBaseline: string
  terminusRepoId: string
  terminusCommit: string
  acceptedCommits: string[]
}
export interface RepairReview {
  harness?: string
  provider?: string
  harnessVersion?: string
  reasoning?: string
  model: string
  verdict: "accept" | "return" | "escalate"
  summary: string
  findings: string[]
}
export interface RepairCandidate {
  workspaceRepoId: string
  proposal: Proposal
  /** Actual edits relative to the automatic merge with conflict files taken from Terminus. */
  repairDiff: string
  repairPaths: string[]
}
type ReviewedCandidate = RepairCandidate & { review: RepairReview }
export type RepairState =
  | { status: "requested" }
  | { status: "running"; workspaceRepoId: string }
  | ({ status: "reviewing" } & RepairCandidate)
  | ({
      status: "ready" | "rejected" | "approved" | "stale"
    } & ReviewedCandidate)
  | ({ status: "integrated"; integrationId: string } & ReviewedCandidate)
  | { status: "failed"; detail: string; workspaceRepoId: string | null }

/** A repair belongs to the conflict and exact source snapshots, never to a Station. */
export interface TechnicianRepair {
  id: string
  networkId: string
  problem?: { kind: "conflict" | "checks" | "review"; id: string }
  validation?: { name: string; command: string[] }[]
  featureBrief?: import("./junction").FeatureBrief
  conflictId: string
  source: RepairSource
  scope: string[]
  description: string
  manifests: WorkManifest[]
  expectedChecks: string[]
  agent: AgentConfig
  createdAt: string
  integrationFailure?: {
    integrationId: string
    detail: string
    evidence?: import("./evidence").Evidence
  }
  state: RepairState
}

export function dispatchTechnician(
  input: Omit<TechnicianRepair, "state">,
  conflict: Conflict
): Transition<TechnicianRepair> {
  if (
    conflict.status !== "open" ||
    conflict.id !== input.conflictId ||
    !conflict.trainIds.includes(input.source.trainId)
  )
    return reject("invalid_input", "Repair requires its Train's open conflict")
  if (
    !input.scope.length ||
    input.scope.some((path) => !path || !conflict.paths.includes(path)) ||
    conflict.paths.some((path) => !input.scope.includes(path))
  )
    return reject(
      "invalid_input",
      "This repair must cover exactly the conflicted files"
    )
  return accept({ ...input, state: { status: "requested" } }, [
    {
      type: "technician.dispatched",
      repairId: input.id,
      trainId: input.source.trainId,
    },
  ])
}

export function startRepair(
  repair: TechnicianRepair,
  workspaceRepoId: string
): Transition<TechnicianRepair> {
  if (repair.state.status !== "requested" || !workspaceRepoId)
    return reject("invalid_state", "Repair is not awaiting a workspace")
  return accept({ ...repair, state: { status: "running", workspaceRepoId } }, [
    {
      type: "technician.started",
      repairId: repair.id,
      trainId: repair.source.trainId,
    },
  ])
}

export function submitRepair(
  repair: TechnicianRepair,
  candidate: RepairCandidate
): Transition<TechnicianRepair> {
  if (
    repair.state.status !== "running" ||
    repair.state.workspaceRepoId !== candidate.workspaceRepoId
  )
    return reject(
      "invalid_state",
      "Candidate does not belong to the running repair"
    )
  if (candidate.repairPaths.some((path) => !repair.scope.includes(path)))
    return reject(
      "invalid_input",
      "Technician changed a file outside the repair scope"
    )
  return accept({ ...repair, state: { status: "reviewing", ...candidate } }, [
    {
      type: "technician.candidate_prepared",
      repairId: repair.id,
      trainId: repair.source.trainId,
    },
  ])
}

export function reviewRepair(
  repair: TechnicianRepair,
  review: RepairReview
): Transition<TechnicianRepair> {
  if (repair.state.status !== "reviewing")
    return reject("invalid_state", "Repair has no candidate awaiting review")
  if (
    review.verdict === "accept" &&
    unmetRequiredChecks(repair.state.proposal.evidence, repair.expectedChecks)
      .length
  )
    return reject(
      "required_checks_failed",
      "Repair cannot be accepted with missing or failing evidence"
    )
  return accept(
    {
      ...repair,
      state: {
        ...repair.state,
        status: review.verdict === "accept" ? "ready" : "rejected",
        review,
      },
    },
    [
      {
        type: "technician.reviewed",
        repairId: repair.id,
        trainId: repair.source.trainId,
      },
    ]
  )
}

export function approveRepair(
  repair: TechnicianRepair,
  heads: { trainCommit: string; terminusCommit: string }
): Transition<TechnicianRepair> {
  if (repair.state.status !== "ready")
    return reject("invalid_state", "Only a reviewed repair can be approved")
  if (
    repair.state.review.verdict !== "accept" ||
    unmetRequiredChecks(repair.state.proposal.evidence, repair.expectedChecks)
      .length
  )
    return reject(
      "required_checks_failed",
      "Repair approval requires accepted review and passing checks"
    )
  if (!repairMatches(repair, heads))
    return reject(
      "stale_base",
      "Source snapshots moved; dispatch a fresh repair for review"
    )
  return accept({ ...repair, state: { ...repair.state, status: "approved" } }, [
    {
      type: "technician.approved",
      repairId: repair.id,
      trainId: repair.source.trainId,
    },
  ])
}

export function failRepair(
  repair: TechnicianRepair,
  detail: string
): Transition<TechnicianRepair> {
  if (!["requested", "running"].includes(repair.state.status))
    return reject(
      "invalid_state",
      "A durable candidate must retain its evidence and review"
    )
  return accept(
    {
      ...repair,
      state: {
        status: "failed",
        detail,
        workspaceRepoId:
          repair.state.status === "running"
            ? repair.state.workspaceRepoId
            : null,
      },
    },
    [
      {
        type: "technician.failed",
        repairId: repair.id,
        trainId: repair.source.trainId,
      },
    ]
  )
}

export function integrateRepair(
  repair: TechnicianRepair,
  integrationId: string
): Transition<TechnicianRepair> {
  if (repair.state.status !== "approved")
    return reject("invalid_state", "Repair was not approved")
  return accept(
    {
      ...repair,
      state: { ...repair.state, status: "integrated", integrationId },
    },
    [
      {
        type: "technician.integrated",
        repairId: repair.id,
        trainId: repair.source.trainId,
      },
    ]
  )
}

export function repairMatches(
  repair: TechnicianRepair,
  heads: { trainCommit: string; terminusCommit: string }
): boolean {
  return (
    repair.source.trainCommit === heads.trainCommit &&
    repair.source.terminusCommit === heads.terminusCommit
  )
}

/** Only a reviewed, independently validated, explicitly approved reconciliation covers its own conflict.
 * The persisted conflict stays open until the exact candidate has been promoted. */
export function conflictsForRepair(
  conflicts: Conflict[],
  repair: TechnicianRepair | null,
  heads: { trainCommit: string; terminusCommit: string }
): Conflict[] {
  if (
    !repair ||
    repair.state.status !== "approved" ||
    !repairMatches(repair, heads) ||
    unmetRequiredChecks(repair.state.proposal.evidence, repair.expectedChecks)
      .length
  )
    return conflicts
  return conflicts.filter((conflict) => conflict.id !== repair.conflictId)
}

export function staleRepair(
  repair: TechnicianRepair
): Transition<TechnicianRepair> {
  if (repair.state.status !== "ready" && repair.state.status !== "approved")
    return reject("invalid_state", "Only a reviewed candidate can become stale")
  return accept({ ...repair, state: { ...repair.state, status: "stale" } }, [
    {
      type: "technician.stale",
      repairId: repair.id,
      trainId: repair.source.trainId,
    },
  ])
}

export function rejectApprovedRepair(
  repair: TechnicianRepair,
  integrationId: string,
  detail: string,
  evidence?: import("./evidence").Evidence
): Transition<TechnicianRepair> {
  if (repair.state.status !== "approved")
    return reject("invalid_state", "Repair is not awaiting integration")
  return accept(
    {
      ...repair,
      integrationFailure: {
        integrationId,
        detail,
        ...(evidence ? { evidence } : {}),
      },
      state: { ...repair.state, status: "rejected" },
    },
    [
      {
        type: "technician.integration_failed",
        repairId: repair.id,
        trainId: repair.source.trainId,
      },
    ]
  )
}

export function validateRepair(
  repair: TechnicianRepair,
  evidence: import("./evidence").Evidence
): Transition<TechnicianRepair> {
  if (repair.state.status !== "reviewing")
    return reject("invalid_state", "Repair has no candidate to validate")
  return accept(
    {
      ...repair,
      state: {
        ...repair.state,
        proposal: { ...repair.state.proposal, evidence },
      },
    },
    [
      {
        type: "technician.validated",
        repairId: repair.id,
        trainId: repair.source.trainId,
      },
    ]
  )
}
