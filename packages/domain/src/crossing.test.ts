import { beginReturn } from "./terminus"
import { describe, it, expect } from "vitest"
import {
  atDepot,
  clearContext,
  manifest,
  passingEvidence,
  unwrap,
  reviewing,
  review,
} from "./testing"
import { attachCar, arrive, depart } from "./journey"
import {
  approachCrossing,
  completeCrossing,
  evaluateCrossing,
  lineStops,
  nextStop,
  resolveLineRoute,
  startCrossingReview,
  blockCrossing,
  stationCheckpoint,
  validateCrossingTopology,
  type Crossing,
} from "./crossing"
import { removeStation } from "./station-removal"
const approval = {
  evidence: passingEvidence,
  expectedChecks: ["test"],
  verdict: "accept" as const,
}
const pickup = (): Crossing => ({
  id: "x",
  networkId: "net",
  lineId: "red",
  sourceStationId: "external",
  attempt: 0,
  checkpoint: {
    stationId: "external",
    sourceTrainId: "source",
    repoId: "repo",
    commit: "checkpoint",
    carIds: ["original"],
  },
  state: { status: "waiting" },
})
function acceptedCar() {
  const w = reviewing()
  return unwrap(
    attachCar({
      ...w,
      carId: "original",
      review,
      acceptedAt: "2026-10-05T00:00:00Z",
    })
  ).car
}
describe("Crossings", () => {
  it("normalizes old Lines and does not skip a pickup because its source Station completed", () => {
    const w = atDepot()
    expect(lineStops(w.line)).toEqual(
      w.line.stationIds.map((stationId) => ({ kind: "station", stationId }))
    )
    const c = pickup()
    const line = {
      ...w.line,
      stops: [
        {
          kind: "crossing" as const,
          crossingId: c.id,
          stationId: c.sourceStationId,
        },
        ...lineStops(w.line),
      ],
    }
    expect(nextStop(line, w.stations, [c])?.kind).toBe("crossing")
    expect(
      nextStop(line, w.stations, [
        {
          ...c,
          state: {
            status: "complete",
            integrationId: "i",
            commit: "merged",
            copiedCarIds: [],
          },
        },
      ])?.kind
    ).toBe("station")
  })
  it("holds on proposals and revisions until the source checkpoint is accepted", () => {
    const w = atDepot(),
      c = pickup()
    delete c.checkpoint
    for (const status of [
      "waiting",
      "active",
      "revising",
      "ready_for_pickup",
      "in_review",
    ]) {
      expect(
        evaluateCrossing(
          w.train,
          c,
          { ...w.station, state: { status } as typeof w.station.state },
          w.train,
          clearContext()
        )
      ).toMatchObject({ kind: "hold" })
    }
  })
  it("enforces user holds and required-check/conflict gates even with a checkpoint", () => {
    const w = atDepot()
    expect(
      evaluateCrossing(
        w.train,
        pickup(),
        undefined,
        undefined,
        clearContext({
          trainChecks: [{ name: "test", required: true, status: "failed" }],
        })
      ).kind
    ).toBe("block")
    expect(
      evaluateCrossing(
        w.train,
        pickup(),
        undefined,
        undefined,
        clearContext({
          holds: [
            { id: "h", kind: "user", scope: { kind: "network" }, note: "wait" },
          ],
        })
      ).kind
    ).toBe("hold")
  })
  it("blocks unresolvable sources but retains accepted checkpoints after source siding", () => {
    const w = atDepot(),
      c = pickup()
    const sided = {
      ...w.train,
      state: { status: "siding" as const, reason: "done" },
    }
    expect(
      evaluateCrossing(w.train, c, undefined, sided, clearContext()).kind
    ).toBe("clear")
    delete c.checkpoint
    expect(
      evaluateCrossing(w.train, c, undefined, sided, clearContext()).kind
    ).toBe("block")
  })
  it("approaches and docks at the shared Station without changing it", () => {
    const w = atDepot(),
      c = pickup()
    const approach = unwrap(approachCrossing(w.train, c, clearContext()))
    expect(approach.state).toMatchObject({
      status: "approaching",
      toward: "external",
      crossingId: "x",
    })
    expect(unwrap(arrive(approach)).state).toMatchObject({
      status: "docked",
      at: "external",
      crossingId: "x",
    })
    expect(
      approachCrossing(w.train, { ...c, checkpoint: undefined }, clearContext())
        .ok
    ).toBe(false)
  })
  it("copies provenance while retaining receiving Cars and deduplicating transitive origins", () => {
    const w = atDepot(),
      original = acceptedCar(),
      own = { ...original, id: "own", trainId: w.train.id }
    const c = {
      ...pickup(),
      state: { status: "integrating" as const, integrationId: "i" },
    }
    const train = {
      ...w.train,
      carIds: [own.id],
      state: {
        status: "reviewing" as const,
        from: { kind: "depot" as const },
        at: "external",
        crossingId: "x",
      },
    }
    const result = unwrap(
      completeCrossing(train, c, [original], [own], "merge", "now", approval)
    )
    expect(result.train.carIds).toEqual(["own", "x-car-original"])
    expect(result.cars[0]).toMatchObject({
      originCarId: "original",
      sourceCarId: "original",
      review: original.review,
      evidence: original.evidence,
      acceptedAt: original.acceptedAt,
      acceptedCommit: original.acceptedCommit,
      position: 2,
    })
    const inherited = {
      ...original,
      id: "other-copy",
      trainId: train.id,
      originCarId: "original",
    }
    expect(
      unwrap(
        completeCrossing(
          { ...train, carIds: [...train.carIds, inherited.id] },
          c,
          [original],
          [own, inherited],
          "merge",
          "now",
          approval
        )
      ).cars
    ).toEqual([])
  })
  it("rejects invalid pickup completion and missing checkpoint Cars", () => {
    const w = atDepot(),
      c = pickup()
    expect(completeCrossing(w.train, c, [], [], "m", "now", approval).ok).toBe(
      false
    )
    const t = {
      ...w.train,
      state: {
        status: "reviewing" as const,
        from: { kind: "depot" as const },
        at: "external",
        crossingId: "x",
      },
    }
    expect(
      completeCrossing(
        t,
        { ...c, state: { status: "integrating", integrationId: "i" } },
        [],
        [],
        "m",
        "now",
        approval
      ).ok
    ).toBe(false)
  })
  it("records only the accepted prefix", () => {
    const w = reviewing()
    const accepted = unwrap(
      attachCar({ ...w, carId: "original", review, acceptedAt: "now" })
    )
    expect(stationCheckpoint(accepted.train, accepted.station)?.carIds).toEqual(
      ["original"]
    )
    expect(stationCheckpoint(w.train, w.station)).toBeNull()
  })
  it("requires every owned Station once in a route", () => {
    const w = atDepot(),
      keys = new Map([
        ["a", "s1"],
        ["b", "s2"],
      ])
    expect(() =>
      resolveLineRoute(w.line, [{ kind: "station", key: "a" }], keys)
    ).toThrow()
    const result = resolveLineRoute(
      w.line,
      [
        {
          kind: "crossing",
          source: { kind: "existing", stationId: "external" },
        },
        { kind: "station", key: "a" },
        { kind: "station", key: "b" },
      ],
      keys
    )
    expect(result.crossings[0]?.sourceStationId).toBe("external")
  })
  it("rejects reciprocal Line flow, own-Line pickup and mixed dependency cycles", () => {
    const a = atDepot(1),
      b = { ...a.station, id: "b1", lineId: "blue", manifest: manifest() }
    const blue = {
      id: "blue",
      networkId: "net",
      name: "Blue",
      stationIds: [b.id],
    }
    const crossed = resolveLineRoute(
      blue,
      [
        { kind: "crossing", source: { kind: "existing", stationId: "s1" } },
        { kind: "station", key: "b" },
      ],
      new Map([["b", b.id]])
    ).line
    expect(validateCrossingTopology([a.line, crossed], [a.station, b])).toEqual(
      []
    )
    const reverse = resolveLineRoute(
      a.line,
      [
        { kind: "crossing", source: { kind: "existing", stationId: b.id } },
        { kind: "station", key: "a" },
      ],
      new Map([["a", "s1"]])
    ).line
    expect(
      validateCrossingTopology([reverse, crossed], [a.station, b]).join()
    ).toContain("one-way")
    expect(
      validateCrossingTopology(
        [a.line, crossed],
        [{ ...a.station, manifest: manifest({ dependencies: [b.id] }) }, b]
      ).join()
    ).toContain("cycle")
  })
  it("protects source Stations from removal", () => {
    const w = atDepot()
    expect(
      removeStation({
        ...w,
        reason: "remove",
        crossings: [{ ...pickup(), sourceStationId: w.station.id }],
      }).ok
    ).toBe(false)
  })
})

it("starts receiving review only when docked and blocks independently of source Station", () => {
  const w = atDepot(),
    c = pickup(),
    train = unwrap(arrive(unwrap(approachCrossing(w.train, c, clearContext()))))
  const started = unwrap(startCrossingReview(train, c, "i"))
  expect(started.train.state.status).toBe("reviewing")
  expect(started.crossing.attempt).toBe(1)
  expect(startCrossingReview(w.train, c, "i").ok).toBe(false)
  const blocked = unwrap(
    blockCrossing(started.train, started.crossing, [
      { kind: "conflict", detail: "Conflict" },
    ])
  )
  expect(blocked.train.state.status).toBe("blocked")
  expect(blocked.crossing.state.status).toBe("blocked")
})
it("cannot complete a Crossing on failed evidence or a rejected review", () => {
  const w = atDepot(),
    original = acceptedCar(),
    c = pickup(),
    train = unwrap(arrive(unwrap(approachCrossing(w.train, c, clearContext()))))
  const started = unwrap(startCrossingReview(train, c, "i"))
  expect(
    completeCrossing(
      started.train,
      started.crossing,
      [original],
      [],
      "merge",
      "now",
      { ...approval, verdict: "return" }
    ).ok
  ).toBe(false)
  expect(
    completeCrossing(
      started.train,
      started.crossing,
      [original],
      [],
      "merge",
      "now",
      { ...approval, evidence: { checks: [] } }
    ).ok
  ).toBe(false)
  expect(
    approachCrossing(
      w.train,
      c,
      clearContext({
        holds: [
          {
            id: "hold",
            kind: "user",
            scope: { kind: "network" },
            note: "Wait",
          },
        ],
      })
    ).ok
  ).toBe(false)
})

it("prevents owned work and Terminus return from skipping unfinished route visits", () => {
  const w = atDepot(),
    c = pickup()
  c.lineId = w.line.id
  w.line.stops = [
    { kind: "crossing", crossingId: c.id, stationId: c.sourceStationId },
    ...lineStops(w.line),
  ]
  expect(depart({ ...w, context: clearContext(), crossings: [c] }).ok).toBe(
    false
  )
  const completed = {
    ...c,
    state: {
      status: "complete" as const,
      integrationId: "i",
      commit: "merged",
      copiedCarIds: [],
    },
  }
  expect(
    depart({ ...w, context: clearContext(), crossings: [completed] }).ok
  ).toBe(true)
  w.stations = w.stations.map((s) => ({
    ...s,
    state: { status: "cancelled" as const, reason: "cancelled" },
  }))
  expect(beginReturn({ ...w, crossings: [c] }).ok).toBe(false)
  expect(beginReturn({ ...w, crossings: [completed] }).ok).toBe(true)
})
