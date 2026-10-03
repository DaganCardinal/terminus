import type { WorkManifest } from "@terminus/domain"
import { describe, expect, it } from "vitest"
import { FakeConductor, FakeStationRunner } from "./fakes"

const manifest: WorkManifest = {
  goal: "Add a footer",
  scope: [],
  expectedAreas: ["src/footer.tsx"],
  avoidAreas: [],
  contracts: [],
  invariants: [],
  dependencies: [],
  acceptanceCriteria: [],
  expectedEvidence: [],
}

const proposal = {
  headCommit: "abc",
  changedPaths: [],
  evidence: { checks: [] },
  agent: { harness: "fake", model: "fake" },
  agentSummary: null,
}

describe("FakeStationRunner", () => {
  it("proposes passing work derived from the run", async () => {
    const result = await new FakeStationRunner().run({
      stationId: "s1",
      runId: "s1-s1-r0",
      manifest,
      workspace: { repoId: "repo", baseCommit: "base" },
      feedback: null,
    })
    expect(result).toMatchObject({
      ok: true,
      proposal: {
        headCommit: "fake-s1-s1-r0",
        changedPaths: ["src/footer.tsx"],
      },
    })
  })
})

describe("FakeConductor", () => {
  it("returns work the configured number of times, then accepts", async () => {
    const conductor = new FakeConductor({ returns: 1 })
    const review = (revisionCount: number) =>
      conductor.review({
        stationId: "s1",
        manifest,
        proposal,
        trainHead: "base",
        revisionCount,
      })
    expect((await review(0)).verdict).toBe("return")
    expect((await review(1)).verdict).toBe("accept")
  })
})
