import { describe, expect, it, vi } from "vitest"
import type { TechnicianRepair } from "@terminus/domain"
import type {
  CrossingReviewInput,
  JunctionReviewInput,
} from "@terminus/protocol"
import {
  HarnessConductor,
  HarnessRepairConductor,
  type ConductorSession,
  type ConductorSessionFactory,
  type ReviewPreparation,
} from "./conductor-agent"
import type { ReviewContext, ReviewInput } from "./roles"

const review: ReviewInput = {
  stationId: "station",
  manifest: {
    goal: "Add a footer",
    scope: [],
    expectedAreas: ["src/Footer.tsx"],
    avoidAreas: ["package.json"],
    contracts: [],
    invariants: [],
    dependencies: [],
    acceptanceCriteria: ["Accessible footer"],
    expectedEvidence: ["test"],
  },
  trainHead: "b".repeat(40),
  revisionCount: 1,
  proposal: {
    headCommit: "c".repeat(40),
    changedPaths: ["src/Footer.tsx"],
    diff: "+export function Footer() {}",
    evidence: {
      checks: [
        {
          name: "test",
          required: true,
          status: "passed",
          exitCode: 0,
          stdout: "1 test passed",
        },
      ],
    },
    agent: { harness: "opencode", model: "station-model" },
    agentSummary: "Added the footer",
  },
}
const context: ReviewContext = {
  repoId: "n/station-a",
  validation: [{ name: "test", command: ["npm", "test"] }],
}
const car = {
  id: "car-source",
  trainId: "train-source",
  stationId: "station-source",
  position: 1,
  manifest: { ...review.manifest, goal: "Add the API client" },
  stationAgent: { harness: "opencode", model: "station-model" },
  sourceCommit: "d".repeat(40),
  acceptedCommit: "e".repeat(40),
  changedPaths: ["src/api.ts"],
  diff: "+export const api = {}",
  evidence: { checks: [] },
  agentSummary: null,
  review: { summary: "Accepted", findings: [], model: "m" },
  acceptedAt: "2026-10-07T00:00:00.000Z",
}
const crossing: CrossingReviewInput = {
  kind: "crossing",
  crossingId: "crossing-1",
  sourceStationId: "station-source",
  sourceCommit: "e".repeat(40),
  targetCommit: "b".repeat(40),
  candidateCommit: "f".repeat(40),
  diff: "+export const api = {}",
  changedPaths: ["src/api.ts"],
  evidence: review.proposal.evidence,
  sourceCars: [car],
  receivingCars: [],
  downstreamManifests: [review.manifest],
}
const junction: JunctionReviewInput = {
  kind: "junction_feature",
  junctionId: "junction-1",
  brief: {
    goal: "Ship checkout",
    scope: ["src/"],
    contracts: [],
    invariants: [],
    acceptanceCriteria: ["Checkout completes"],
    validation: context.validation!,
  },
  sourceCommit: "f".repeat(40),
  targetCommit: "b".repeat(40),
  candidateCommit: "f".repeat(40),
  diff: "+checkout",
  changedPaths: ["src/checkout.ts"],
  evidence: review.proposal.evidence,
  sourceCars: [car],
  receivingCars: [],
  repairIds: [],
}
const repair = {
  id: "repair-1",
  networkId: "n",
  conflictId: "conflict-1",
  source: {
    integrationId: "integration-1",
    trainId: "train-a",
    trainRepoId: "n/train-a",
    trainCommit: "a".repeat(40),
    trainBaseline: "b".repeat(40),
    terminusRepoId: "n/terminus",
    terminusCommit: "b".repeat(40),
    acceptedCommits: [],
  },
  scope: ["src/App.tsx"],
  description: "Reconcile the App header",
  manifests: [review.manifest],
  expectedChecks: ["test"],
  agent: { harness: "opencode", model: "technician-model" },
  createdAt: "2026-10-07T00:00:00.000Z",
  state: {
    status: "reviewing",
    workspaceRepoId: "n/repair-1",
    proposal: { ...review.proposal, headCommit: "9".repeat(40) },
    repairDiff: "+resolved header",
    repairPaths: ["src/App.tsx"],
  },
} satisfies TechnicianRepair
const accept = { verdict: "accept", summary: "Footer renders", findings: [] }

/** Scripted final messages; records what the Conductor sent. */
function scripted(
  replies: (string | object)[],
  preparation: ReviewPreparation = { install: { exitCode: 0, outputTail: "" } }
) {
  const queue = [...replies]
  const text = () => {
    const reply = queue.shift()!
    return typeof reply === "string" ? reply : JSON.stringify(reply)
  }
  const session = {
    prepare: vi.fn<ConductorSession["prepare"]>(async () => preparation),
    start: vi.fn<ConductorSession["start"]>(async () => text()),
    resume: vi.fn<ConductorSession["resume"]>(async () => text()),
    close: vi.fn<ConductorSession["close"]>(async () => {}),
  }
  const sessions: ConductorSessionFactory = { open: vi.fn(() => session) }
  const conductor = new HarnessConductor("configured", sessions)
  const repairs = new HarnessRepairConductor("configured", sessions)
  return { session, sessions, conductor, repairs }
}

describe("harness Conductor", () => {
  it("verifies the exact candidate in one session and returns its verdict", async () => {
    const { session, sessions, conductor } = scripted([
      `Verified the build.\n\`\`\`json\n${JSON.stringify(accept)}\n\`\`\``,
    ])
    expect(await conductor.review(review, context)).toEqual(accept)
    expect(sessions.open).toHaveBeenCalledWith({
      model: "configured",
      candidate: { repoId: "n/station-a", commit: review.proposal.headCommit },
    })
    const material = session.prepare.mock.calls[0]![0]
    expect(material["candidate.diff"]).toBe(review.proposal.diff)
    expect(JSON.parse(material["evidence.json"]!)).toEqual(
      review.proposal.evidence
    )
    expect(JSON.parse(material["review.json"]!)).toEqual(review)
    const [system, message] = session.start.mock.calls[0]!
    expect(system).toContain("## Verifying the Candidate")
    expect(system).toContain("Never modify tracked files")
    expect(system).toContain("## Verdict JSON schema")
    expect(system).not.toContain("You have no repository browsing")
    expect(message).toContain(
      `fast-forward the Train from commit ${review.trainHead}`
    )
    expect(message).toContain('"acceptanceCriteria":["Accessible footer"]')
    expect(message).toContain('"command":["npm","test"]')
    expect(message).toContain("`npm ci` in /workspace/repo succeeded")
    // Check output stays in the review files, out of the command line.
    expect(message).not.toContain("1 test passed")
    expect(session.resume).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("reports a failed dependency install as context", async () => {
    const { session, conductor } = scripted([accept], {
      install: { exitCode: 1, outputTail: "ERESOLVE could not resolve" },
    })
    await conductor.review(review, context)
    const message = session.start.mock.calls[0]![1]
    expect(message).toContain("failed with exit code 1")
    expect(message).toContain("ERESOLVE could not resolve")
  })

  it("returns failed required checks and escalates a missing diff without a session", async () => {
    const { sessions, conductor } = scripted([])
    expect(
      await conductor.review(
        {
          ...review,
          proposal: { ...review.proposal, evidence: { checks: [] } },
        },
        context
      )
    ).toMatchObject({ verdict: "return" })
    expect(
      await conductor.review(
        { ...review, proposal: { ...review.proposal, diff: undefined } },
        context
      )
    ).toMatchObject({ verdict: "escalate" })
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it("corrects an invalid verdict in the same session", async () => {
    const { session, conductor } = scripted([
      "The footer looks fine.",
      { verdict: "ship_it", summary: "", findings: [] },
      accept,
    ])
    expect(await conductor.review(review, context)).toEqual(accept)
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(session.resume.mock.calls[0]![0]).toContain("invalid_json")
    expect(session.resume.mock.calls[1]![0]).toContain('"path":"verdict"')
  })

  it("fails after two corrections and always closes the session", async () => {
    const { session, conductor } = scripted(["no", "still no", "never"])
    await expect(conductor.review(review, context)).rejects.toThrow(
      "failed validation after 3 attempts"
    )
    expect(session.close).toHaveBeenCalledOnce()
    const broken = scripted([])
    broken.session.prepare.mockRejectedValueOnce(new Error("Sandbox lost"))
    await expect(broken.conductor.review(review, context)).rejects.toThrow(
      "Sandbox lost"
    )
    expect(broken.session.close).toHaveBeenCalledOnce()
  })

  it("verifies Crossing, Junction and repair candidates with their own guidance and material", async () => {
    const f = scripted([accept, accept, accept])
    const at = { ...context, repoId: "n/candidate" }
    expect(await f.conductor.reviewCrossing(crossing, at)).toEqual(accept)
    expect(await f.conductor.reviewJunction(junction, at)).toEqual(accept)
    expect(
      await f.repairs.review(repair, { ...context, repoId: "n/repair-1" })
    ).toMatchObject({ ...accept, model: "configured" })
    expect(vi.mocked(f.sessions.open).mock.calls.map(([o]) => o)).toEqual([
      {
        model: "configured",
        candidate: { repoId: "n/candidate", commit: crossing.candidateCommit },
      },
      {
        model: "configured",
        candidate: { repoId: "n/candidate", commit: junction.candidateCommit },
      },
      {
        model: "configured",
        candidate: {
          repoId: "n/repair-1",
          commit: repair.state.proposal.headCommit,
        },
      },
    ])
    const [crossingStart, junctionStart, repairStart] =
      f.session.start.mock.calls
    expect(crossingStart![0]).toContain(
      "## This Review\n\nReview a one-way Crossing"
    )
    expect(crossingStart![1]).toContain("Crossing review: Crossing crossing-1")
    // Source Cars are summarized inline; their diffs stay in review.json.
    expect(crossingStart![1]).toContain('"goal":"Add the API client"')
    expect(crossingStart![1]).not.toContain("export const api")
    expect(junctionStart![0]).toContain("Review Junction feature convergence")
    expect(junctionStart![1]).toContain("(junction_feature)")
    expect(junctionStart![1]).toContain(
      '"acceptanceCriteria":["Checkout completes"]'
    )
    expect(repairStart![0]).toContain("Review a Technician reconciliation")
    expect(repairStart![1]).toContain("repair.diff")
    const repairFiles = f.session.prepare.mock.calls[2]![0]
    expect(repairFiles["repair.diff"]).toBe("+resolved header")
    expect(repairFiles["candidate.diff"]).toBe(review.proposal.diff)
    expect(f.session.close).toHaveBeenCalledTimes(3)
  })
})
