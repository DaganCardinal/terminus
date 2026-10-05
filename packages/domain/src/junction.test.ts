import { describe, it, expect } from "vitest"
import {
  createJunction,
  acceptJunctionInput,
  startJunctionReview,
  readyJunction,
  releaseJunction,
  blockJunction,
  retryJunction,
  abandonJunction,
  copyJunctionCars,
  isCanonicalUnload,
  type Junction,
} from "./junction"
import { createLine } from "./line"
import { createTrain } from "./train"
import { evaluateTerminusEntry } from "./engineer"
import { beginReturn, completeIntegration } from "./terminus"
import { attachCar } from "./journey"
import { validateCrossingTopology } from "./crossing"
import {
  unwrap,
  passingEvidence,
  failingEvidence,
  clearContext,
  reviewing,
  review,
} from "./testing"
const approval = {
  evidence: passingEvidence,
  expectedChecks: ["test"],
  verdict: "accept" as const,
}
function fixture(): Junction {
  return unwrap(
    createJunction({
      id: "j",
      networkId: "n",
      name: "Feature",
      repoId: "jr",
      headCommit: "base",
      terminusBaseline: "base",
      incomingLineIds: ["a", "b"],
      incomingTrainIds: ["ta", "tb"],
      outgoingLineId: "out",
      outgoingTrainId: "tout",
      outgoingUnloadMode: "auto",
      brief: {
        goal: "Feature",
        scope: ["src/"],
        contracts: [],
        invariants: [],
        acceptanceCriteria: ["works"],
        validation: [{ name: "test", command: ["npm", "test"] }],
      },
      conductorModel: "fake",
      createdAt: "now",
    })
  )
}
const input = (i = 0) => ({
  trainId: i ? "tb" : "ta",
  lineId: i ? "b" : "a",
  sourceCommit: `s${i}`,
  mergeCommit: `m${i}`,
  integrationId: `i${i}`,
  carIds: [],
})
function assembled() {
  return unwrap(
    acceptJunctionInput(
      unwrap(acceptJunctionInput(fixture(), input(), approval)),
      input(1),
      approval
    )
  )
}
function ready() {
  const j = unwrap(startJunctionReview(assembled()))
  return unwrap(
    readyJunction(
      j,
      {
        commit: j.headCommit,
        evidence: passingEvidence,
        review: { ...review, verdict: "accept" },
        diff: "feature",
        changedPaths: ["src/"],
      },
      ["test"]
    )
  )
}
describe("Junction lifecycle", () => {
  it("requires fixed distinct membership and rejects undeclared inputs", () => {
    expect(
      createJunction({ ...fixture(), incomingLineIds: ["a", "a"] }).ok
    ).toBe(false)
    expect(createJunction({ ...fixture(), incomingTrainIds: ["ta"] }).ok).toBe(
      false
    )
    expect(
      acceptJunctionInput(
        fixture(),
        { ...input(), trainId: "outsider" },
        approval
      ).ok
    ).toBe(false)
    expect(
      acceptJunctionInput(fixture(), { ...input(), lineId: "b" }, approval).ok
    ).toBe(false)
  })
  it("accepts only passing independently reviewed inputs and idempotent exact receipts", () => {
    expect(
      acceptJunctionInput(fixture(), input(), {
        ...approval,
        verdict: "return",
      }).ok
    ).toBe(false)
    expect(
      acceptJunctionInput(fixture(), input(), {
        ...approval,
        evidence: failingEvidence,
      }).ok
    ).toBe(false)
    expect(
      acceptJunctionInput(fixture(), input(), {
        ...approval,
        evidence: { checks: [] },
      }).ok
    ).toBe(false)
    const j = unwrap(acceptJunctionInput(fixture(), input(), approval))
    expect(acceptJunctionInput(j, input(), approval)).toMatchObject({
      ok: true,
      events: [],
    })
    expect(
      acceptJunctionInput(j, { ...input(), sourceCommit: "moved" }, approval).ok
    ).toBe(false)
    expect(startJunctionReview(j).ok).toBe(false)
  })
  it("requires complete-feature checks and exact accepted commit approval", () => {
    const j = unwrap(startJunctionReview(assembled())),
      a = {
        commit: j.headCommit,
        evidence: passingEvidence,
        review: { ...review, verdict: "accept" as const },
        diff: "diff",
        changedPaths: [],
      }
    expect(readyJunction(j, { ...a, commit: "stale" }, ["test"]).ok).toBe(false)
    expect(
      readyJunction(j, { ...a, evidence: failingEvidence }, ["test"]).ok
    ).toBe(false)
    expect(
      readyJunction(j, { ...a, review: { ...review, verdict: "return" } }, [
        "test",
      ]).ok
    ).toBe(false)
    expect(releaseJunction(j, j.headCommit).ok).toBe(false)
    const accepted = ready(),
      released = unwrap(releaseJunction(accepted, accepted.headCommit))
    expect(releaseJunction(accepted, "stale").ok).toBe(false)
    expect(releaseJunction(released, released.headCommit)).toMatchObject({
      ok: true,
      events: [],
    })
    expect(releaseJunction(released, "stale").ok).toBe(false)
  })
  it("retries retain inputs and invalidate acceptance; abandonment is terminal", () => {
    const j = ready(),
      blocked = unwrap(
        blockJunction(j, [{ kind: "review_escalated", detail: "repair" }])
      )
    const retry = unwrap(retryJunction(blocked))
    expect(retry.inputs).toEqual(j.inputs)
    expect(retry.acceptance).toBeUndefined()
    expect(retry.attempt).toBe(1)
    expect(retryJunction(j).ok).toBe(false)
    const abandoned = unwrap(abandonJunction(blocked, "cancel feature"))
    expect(abandoned.inputs).toEqual(j.inputs)
    expect(releaseJunction(abandoned, j.headCommit).ok).toBe(false)
    expect(
      blockJunction(abandoned, [{ kind: "needs_user", detail: "wait" }]).ok
    ).toBe(false)
    expect(
      abandonJunction(unwrap(releaseJunction(j, j.headCommit)), "stop").ok
    ).toBe(false)
  })
  it("deduplicates Crossing origins in integration order and preserves immutable provenance", () => {
    const w = reviewing(),
      car = unwrap(
        attachCar({ ...w, carId: "original", review, acceptedAt: "accepted" })
      ).car
    const a = { ...car, trainId: "ta" },
      b = {
        ...car,
        id: "copy",
        trainId: "tb",
        originCarId: car.id,
        sourceCarId: car.id,
        crossingId: "x",
      }
    const j = {
      ...assembled(),
      inputs: [
        { ...input(), carIds: [a.id] },
        { ...input(1), carIds: [b.id] },
      ],
    }
    const copied = copyJunctionCars(j, [a, b], "copied")
    expect(copied).toHaveLength(1)
    expect(copied[0]).toMatchObject({
      id: "j-car-original",
      trainId: "tout",
      originCarId: "original",
      sourceCarId: "original",
      junctionId: "j",
      acceptedAt: car.acceptedAt,
      acceptedCommit: car.acceptedCommit,
      evidence: car.evidence,
      review: car.review,
    })
    expect(copyJunctionCars(j, [a, b], "later")[0]!.id).toBe(copied[0]!.id)
    expect(() => copyJunctionCars(j, [], "now")).toThrow(/Missing/)
  })
  it("allows empty Junction-origin routes while rejecting nested features and ordinary empty Lines", () => {
    const opts = { id: "out", networkId: "n", name: "Out", stations: [] }
    expect(createLine(opts).ok).toBe(false)
    expect(
      createLine({
        ...opts,
        origin: { kind: "junction", junctionId: "j" },
        destination: { kind: "junction", junctionId: "j2" },
      }).ok
    ).toBe(false)
    const { line, stations } = unwrap(
      createLine({ ...opts, origin: { kind: "junction", junctionId: "j" } })
    )
    const train = unwrap(
      createTrain({
        id: "t",
        line,
        repoId: "r",
        terminusCommit: "base",
        headCommit: "feature",
      })
    )
    expect(train.state).toMatchObject({
      status: "ready",
      at: { kind: "junction", junctionId: "j" },
    })
    expect(unwrap(beginReturn({ train, line, stations })).state.status).toBe(
      "returning"
    )
  })
  it("keeps Junction unloading distinct from canonical promotion and still enforces hard gates", () => {
    const w = reviewing(),
      train = {
        ...w.train,
        destination: { kind: "junction" as const, junctionId: "j" },
        state: { status: "returning" as const, phase: "integrating" as const },
      }
    const policy = { trainId: train.id, mode: "human_approval" as const }
    expect(
      evaluateTerminusEntry(train, { ...clearContext(), unloadPolicy: policy })
        .kind
    ).toBe("clear")
    expect(
      evaluateTerminusEntry(
        train,
        clearContext({ trainChecks: failingEvidence.checks })
      ).kind
    ).toBe("block")
    expect(
      evaluateTerminusEntry(
        train,
        clearContext({
          holds: [
            { id: "h", kind: "user", scope: { kind: "network" }, note: "wait" },
          ],
        })
      ).kind
    ).toBe("hold")
    const result = completeIntegration({
      train,
      mergeCommit: "feature",
      evidence: passingEvidence,
      expectedChecks: ["test"],
      conflicts: [],
    })
    expect(result.ok && result.events.map((e) => e.type)).not.toContain(
      "terminus.integration_completed"
    )
    expect(isCanonicalUnload(unwrap(result))).toBe(false)
    expect(
      isCanonicalUnload({
        ...unwrap(result),
        state: { status: "unloaded", mergeCommit: "legacy" },
      })
    ).toBe(true)
  })
  it("rejects cross-feature transfers and cycles through release", () => {
    const station = reviewing().station,
      a = {
        ...station,
        id: "a",
        lineId: "in",
        manifest: { ...station.manifest, dependencies: ["out"] },
      },
      out = {
        ...station,
        id: "out",
        lineId: "out",
        manifest: { ...station.manifest, dependencies: [] },
      }
    const lines = [
      {
        id: "in",
        networkId: "n",
        name: "Input",
        stationIds: ["a"],
        destination: { kind: "junction" as const, junctionId: "j" },
      },
      {
        id: "out",
        networkId: "n",
        name: "Output",
        stationIds: ["out"],
        origin: { kind: "junction" as const, junctionId: "j" },
      },
    ]
    expect(validateCrossingTopology(lines, [a, out]).join(" ")).toContain(
      "cycle"
    )
    expect(validateCrossingTopology(lines, [a, out]).join(" ")).toContain(
      "boundar"
    )
  })
})
