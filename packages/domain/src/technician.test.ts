import { describe, expect, it } from "vitest"
import {
  dispatchTechnician,
  validateRepair,
  startRepair,
  submitRepair,
  reviewRepair,
  approveRepair,
  failRepair,
  integrateRepair,
  staleRepair,
  rejectApprovedRepair,
  conflictsForRepair,
  type TechnicianRepair,
  type RepairCandidate,
} from "./technician"
import type { Transition } from "./transition"
const conflict = {
  id: "conflict",
  trainIds: ["train"],
  paths: ["src/shared.ts"],
  description: "Merge conflict",
  status: "open" as const,
}
const input: Omit<TechnicianRepair, "state"> = {
  id: "repair",
  networkId: "network",
  conflictId: conflict.id,
  source: {
    integrationId: "integration",
    trainId: "train",
    trainRepoId: "train-repo",
    trainCommit: "train-head",
    trainBaseline: "baseline",
    terminusRepoId: "terminus",
    terminusCommit: "terminus-head",
    acceptedCommits: ["car"],
  },
  scope: conflict.paths,
  description: conflict.description,
  manifests: [],
  expectedChecks: ["test"],
  agent: { harness: "fake", model: "fake" },
  createdAt: "2026-10-04",
}
const candidate: RepairCandidate = {
  workspaceRepoId: "workspace",
  repairPaths: conflict.paths,
  repairDiff: "actual repair",
  proposal: {
    headCommit: "merge",
    changedPaths: conflict.paths,
    diff: "full merge",
    evidence: { checks: [{ name: "test", required: true, status: "passed" }] },
    agent: input.agent,
    agentSummary: "Everything passed",
  },
}
const verdict = {
  model: "fake",
  verdict: "accept" as const,
  summary: "Preserves both contracts",
  findings: [],
}
const heads = {
  trainCommit: input.source.trainCommit,
  terminusCommit: input.source.terminusCommit,
}
function value<T>(transition: Transition<T>): T {
  if (!transition.ok) throw new Error(transition.error.message)
  return transition.value
}
const requested = () => value(dispatchTechnician(input, conflict))
const running = () => value(startRepair(requested(), "workspace"))
const reviewing = () => value(submitRepair(running(), candidate))
const ready = () => value(reviewRepair(reviewing(), verdict))
const approved = () => value(approveRepair(ready(), heads))

describe("Technician repair domain", () => {
  it("records every transition through explicit approval and integration", () => {
    expect(dispatchTechnician(input, conflict)).toMatchObject({
      events: [{ type: "technician.dispatched" }],
    })
    expect(startRepair(requested(), "workspace")).toMatchObject({
      events: [{ type: "technician.started" }],
    })
    expect(submitRepair(running(), candidate)).toMatchObject({
      events: [{ type: "technician.candidate_prepared" }],
    })
    expect(reviewRepair(reviewing(), verdict)).toMatchObject({
      value: { state: { status: "ready" } },
      events: [{ type: "technician.reviewed" }],
    })
    expect(approveRepair(ready(), heads)).toMatchObject({
      events: [{ type: "technician.approved" }],
    })
    expect(integrateRepair(approved(), "retry")).toMatchObject({
      value: { state: { status: "integrated", integrationId: "retry" } },
      events: [{ type: "technician.integrated" }],
    })
  })
  it("checkpoints independent evidence only for the submitted candidate", () => {
    expect(validateRepair(requested(), { checks: [] }).ok).toBe(false)
    expect(validateRepair(reviewing(), { checks: [] })).toMatchObject({
      value: { state: { proposal: { evidence: { checks: [] } } } },
      events: [{ type: "technician.validated" }],
    })
  })
  it("requires an open conflict, its Train, and exactly the conflicted paths", () => {
    for (const invalid of [
      { ...conflict, status: "resolved" as const },
      { ...conflict, trainIds: ["other"] },
    ])
      expect(dispatchTechnician(input, invalid).ok).toBe(false)
    for (const scope of [[], ["outside"], [...conflict.paths, "outside"]])
      expect(dispatchTechnician({ ...input, scope }, conflict).ok).toBe(false)
  })
  it("rejects invalid states, unrelated workspaces and out-of-scope edits", () => {
    expect(startRepair(running(), "workspace").ok).toBe(false)
    expect(submitRepair(requested(), candidate).ok).toBe(false)
    expect(
      submitRepair(running(), { ...candidate, workspaceRepoId: "other" }).ok
    ).toBe(false)
    expect(
      submitRepair(running(), { ...candidate, repairPaths: ["outside"] }).ok
    ).toBe(false)
    expect(reviewRepair(requested(), verdict).ok).toBe(false)
    expect(approveRepair(reviewing(), heads).ok).toBe(false)
    expect(integrateRepair(ready(), "retry").ok).toBe(false)
  })
  it("retains rejected candidates, actual evidence and review feedback", () => {
    for (const result of ["return", "escalate"] as const) {
      expect(
        value(reviewRepair(reviewing(), { ...verdict, verdict: result })).state
      ).toMatchObject({
        status: "rejected",
        proposal: candidate.proposal,
        review: { verdict: result },
      })
    }
  })
  it("does not accept agent claims over missing or failed independent evidence", () => {
    for (const checks of [
      [],
      [{ name: "test", required: true, status: "failed" as const }],
    ]) {
      const repair = value(
        submitRepair(running(), {
          ...candidate,
          proposal: { ...candidate.proposal, evidence: { checks } },
        })
      )
      expect(reviewRepair(repair, verdict)).toMatchObject({
        ok: false,
        error: { code: "required_checks_failed" },
      })
    }
  })
  it("rejects changed Train and Terminus heads and retains superseded candidates", () => {
    for (const moved of [
      { ...heads, trainCommit: "new-train" },
      { ...heads, terminusCommit: "new-terminus" },
    ])
      expect(approveRepair(ready(), moved)).toMatchObject({
        ok: false,
        error: { code: "stale_base" },
      })
    expect(value(staleRepair(approved())).state).toMatchObject({
      status: "stale",
      proposal: candidate.proposal,
    })
    expect(staleRepair(requested()).ok).toBe(false)
  })
  it("covers only its linked conflict after approval and only at exact source snapshots", () => {
    const other = { ...conflict, id: "unrelated" }
    expect(conflictsForRepair([conflict, other], approved(), heads)).toEqual([
      other,
    ])
    for (const repair of [
      null,
      requested(),
      ready(),
      value(staleRepair(approved())),
    ])
      expect(conflictsForRepair([conflict, other], repair, heads)).toEqual([
        conflict,
        other,
      ])
    expect(
      conflictsForRepair([conflict], approved(), {
        ...heads,
        terminusCommit: "moved",
      })
    ).toEqual([conflict])
  })
  it("records execution failures and retains a candidate when final integration rejects it", () => {
    expect(failRepair(running(), "Harness stopped")).toMatchObject({
      value: { state: { status: "failed", detail: "Harness stopped" } },
      events: [{ type: "technician.failed" }],
    })
    expect(failRepair(ready(), "Error").ok).toBe(false)
    expect(
      value(rejectApprovedRepair(approved(), "retry", "Validation failed"))
        .state
    ).toMatchObject({
      status: "rejected",
      proposal: candidate.proposal,
      review: verdict,
    })
    expect(
      value(
        rejectApprovedRepair(approved(), "retry", "Validation failed", {
          checks: [],
        })
      )
    ).toMatchObject({
      integrationFailure: {
        integrationId: "retry",
        detail: "Validation failed",
        evidence: { checks: [] },
      },
      state: { proposal: candidate.proposal, review: verdict },
    })
    expect(rejectApprovedRepair(ready(), "retry", "Error").ok).toBe(false)
  })
})
