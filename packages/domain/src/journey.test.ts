import { describe, expect, it } from "vitest"
import type { Hold } from "./hold"
import {
  arrive,
  attachCar,
  depart,
  markReadyForPickup,
  recordWorkspace,
  returnToStation,
  startReview,
} from "./journey"
import {
  accepted,
  active,
  agent,
  approaching,
  atDepot,
  clearContext,
  docked,
  eventTypes,
  expectRejected,
  failingEvidence,
  inTransit,
  manifest,
  proposal,
  review,
  reviewing,
  unwrap,
  withStation,
  type World,
} from "./testing"
import type { Train } from "./train"

const feedback = { summary: "Missing a test", findings: ["add a 401 test"] }

function attach(world: World) {
  return attachCar({
    ...world,
    carId: "car",
    review,
    acceptedAt: "2026-10-03T00:00:00Z",
  })
}

function revising(): World {
  const world = reviewing()
  const returned = unwrap(returnToStation({ ...world, feedback }))
  return withStation({ ...world, train: returned.train }, returned.station)
}

describe("depart", () => {
  it("moves the Train in transit and signals the next Station", () => {
    const world = atDepot()
    const result = depart({ ...world, context: clearContext() })
    const { train, station } = unwrap(result)
    expect(train.state).toEqual({
      status: "in_transit",
      from: { kind: "depot" },
      toward: "s1",
    })
    expect(station.state).toEqual({
      status: "signaled",
      trainId: "t",
      workspace: null,
    })
    expect(eventTypes(result)).toEqual(["train.departed", "station.signaled"])
  })

  it("departs toward the Station after the last Car", () => {
    const world = accepted()
    const { station, train } = unwrap(
      depart({ ...world, context: clearContext() })
    )
    expect(station.id).toBe("s2")
    expect(train.state).toMatchObject({
      from: { kind: "station", stationId: "s1" },
    })
  })

  it("does not signal a Station whose dependency is incomplete", () => {
    const world = atDepot()
    const stations = world.stations.map((station) =>
      station.id === "s1"
        ? { ...station, manifest: manifest({ dependencies: ["x1"] }) }
        : station
    )
    const result = depart({
      ...world,
      stations,
      context: clearContext({ dependencies: { x1: "active" } }),
    })
    expectRejected(result, "gate_closed")
    if (!result.ok && result.error.code === "gate_closed") {
      expect(result.error.decision).toEqual({
        kind: "hold",
        reasons: [{ kind: "dependency", stationId: "x1" }],
      })
    }
  })

  it("does not depart under a user hold", () => {
    const hold: Hold = {
      id: "h1",
      kind: "user",
      scope: { kind: "network" },
      note: "",
    }
    expectRejected(
      depart({ ...atDepot(), context: clearContext({ holds: [hold] }) }),
      "gate_closed"
    )
  })

  it("does not depart when the Train's required tests failed", () => {
    expectRejected(
      depart({
        ...atDepot(),
        context: clearContext({ trainChecks: failingEvidence.checks }),
      }),
      "gate_closed"
    )
  })

  it("rejects departing unless ready", () => {
    expectRejected(
      depart({ ...inTransit(), context: clearContext() }),
      "invalid_state"
    )
  })

  it("rejects departing with no Stations left", () => {
    const world = accepted(
      reviewing(docked(approaching(active(inTransit(accepted())))))
    )
    expectRejected(
      depart({ ...world, context: clearContext() }),
      "invalid_state"
    )
  })

  it("rejects departing when the next Station is not waiting", () => {
    const world = atDepot()
    const stations = world.stations.map((station) =>
      station.id === "s1"
        ? {
            ...station,
            state: {
              status: "blocked" as const,
              trainId: "t",
              issues: [{ kind: "station_failed" as const, detail: "" }],
            },
          }
        : station
    )
    expectRejected(
      depart({ ...world, stations, context: clearContext() }),
      "invalid_state"
    )
  })

  it("rejects a Line the Train is not on, or missing Stations", () => {
    const world = atDepot()
    expectRejected(
      depart({
        ...world,
        line: { ...world.line, id: "blue" },
        context: clearContext(),
      }),
      "invalid_input"
    )
    expectRejected(
      depart({ ...world, stations: [], context: clearContext() }),
      "invalid_input"
    )
  })
})

describe("recordWorkspace", () => {
  it("records a workspace forked from the Train's head", () => {
    const world = inTransit()
    const result = recordWorkspace({
      ...world,
      workspace: { repoId: "s1-repo", baseCommit: "t0" },
    })
    expect(unwrap(result).state).toMatchObject({
      status: "signaled",
      workspace: { repoId: "s1-repo", baseCommit: "t0" },
    })
    expect(eventTypes(result)).toEqual(["station.workspace_created"])
  })

  it("rejects a workspace not forked from the Train's latest commit", () => {
    expectRejected(
      recordWorkspace({
        ...inTransit(),
        workspace: { repoId: "s1-repo", baseCommit: "old" },
      }),
      "stale_base"
    )
  })

  it("rejects a second workspace", () => {
    const world = active()
    expectRejected(
      recordWorkspace({
        ...world,
        workspace: { repoId: "again", baseCommit: "t0" },
      }),
      "invalid_state"
    )
  })
})

describe("markReadyForPickup", () => {
  it("starts the Train's approach on a first pass", () => {
    const result = markReadyForPickup({ ...active(), proposal: proposal() })
    const { train, station } = unwrap(result)
    expect(train.state).toEqual({
      status: "approaching",
      from: { kind: "depot" },
      toward: "s1",
    })
    expect(station.state.status).toBe("ready_for_pickup")
    expect(eventTypes(result)).toEqual([
      "station.ready_for_pickup",
      "train.approaching",
    ])
  })

  it("keeps the Train docked after a revision", () => {
    const world = revising()
    const result = markReadyForPickup({ ...world, proposal: proposal() })
    const { train, station } = unwrap(result)
    expect(train).toEqual(world.train)
    expect(station.state.status).toBe("ready_for_pickup")
    expect(eventTypes(result)).toEqual(["station.ready_for_pickup"])
  })

  it("rejects a Station with no work in progress", () => {
    expectRejected(
      markReadyForPickup({ ...inTransit(), proposal: proposal() }),
      "invalid_state"
    )
  })

  it("rejects when the Train is not heading to the Station", () => {
    const world = active()
    const elsewhere: Train = {
      ...world.train,
      state: { status: "in_transit", from: { kind: "depot" }, toward: "s2" },
    }
    expectRejected(
      markReadyForPickup({ ...world, train: elsewhere, proposal: proposal() }),
      "invalid_state"
    )
  })
})

describe("arrive", () => {
  it("docks an approaching Train at its Station", () => {
    const result = arrive(approaching().train)
    expect(unwrap(result).state).toEqual({
      status: "docked",
      from: { kind: "depot" },
      at: "s1",
    })
    expect(eventTypes(result)).toEqual(["train.arrived"])
  })

  it("rejects arriving while work is still in progress", () => {
    expectRejected(arrive(active().train), "invalid_state")
  })
})

describe("startReview", () => {
  it("puts the Train and Station into review", () => {
    const result = startReview(docked())
    const { train, station } = unwrap(result)
    expect(train.state.status).toBe("reviewing")
    expect(station.state.status).toBe("in_review")
    expect(eventTypes(result)).toEqual(["review.started"])
  })

  it("rejects reviewing while the Station is still revising", () => {
    expectRejected(startReview(revising()), "invalid_state")
  })
})

describe("attachCar", () => {
  it("attaches a Car and fast-forwards the Train", () => {
    const result = attach(reviewing())
    const { train, station, car } = unwrap(result)
    expect(train.headCommit).toBe("s1-head")
    expect(train.carIds).toEqual(["car"])
    expect(train.state).toEqual({
      status: "ready",
      at: { kind: "station", stationId: "s1" },
    })
    expect(station.state).toEqual({
      status: "complete",
      trainId: "t",
      carId: "car",
    })
    expect(car).toMatchObject({
      position: 1,
      sourceCommit: "t0",
      acceptedCommit: "s1-head",
      stationAgent: agent,
      review,
    })
    expect(eventTypes(result)).toEqual(["car.attached"])
  })

  it("refuses work whose required tests failed", () => {
    const world = reviewing(
      docked(approaching(active(), proposal({ evidence: failingEvidence })))
    )
    expectRejected(attach(world), "required_checks_failed")
  })

  it("refuses acceptance when manifest-required evidence is absent", () => {
    const world = reviewing()
    const station = {
      ...world.station,
      manifest: {
        ...world.station.manifest,
        expectedEvidence: ["missing-check"],
      },
    }
    expectRejected(attach({ ...world, station }), "required_checks_failed")
  })

  it("refuses work that is no longer a fast-forward of the Train", () => {
    const world = reviewing()
    expectRejected(
      attach({ ...world, train: { ...world.train, headCommit: "patched" } }),
      "not_fast_forward"
    )
  })

  it("rejects attaching outside review", () => {
    expectRejected(attach(docked()), "invalid_state")
  })
})

describe("returnToStation", () => {
  it("returns the work for revision while the Train waits docked", () => {
    const result = returnToStation({ ...reviewing(), feedback })
    const { train, station } = unwrap(result)
    expect(train.state).toEqual({
      status: "docked",
      from: { kind: "depot" },
      at: "s1",
    })
    expect(station.state).toMatchObject({ status: "revising", feedback })
    expect(station.revisionCount).toBe(1)
    expect(station.retryCount).toBe(1)
    expect(station.lastReview?.feedback).toEqual(feedback)
    expect(eventTypes(result)).toEqual(["station.returned"])
  })

  it("rejects returning work that is not in review", () => {
    expectRejected(returnToStation({ ...docked(), feedback }), "invalid_state")
  })

  it("cannot start a fourth automatic revision, but can use a larger configured allowance", () => {
    const world = reviewing()
    world.station = { ...world.station, revisionCount: 3, retryCount: 3 }
    const result = returnToStation({ ...world, feedback })
    expectRejected(result, "gate_closed")
    if (!result.ok && result.error.code === "gate_closed")
      expect(result.error.decision).toMatchObject({
        kind: "block",
        issues: [{ kind: "station_retries_exhausted" }],
      })
    expect(
      unwrap(returnToStation({ ...world, feedback, maxRetries: 4 })).station
        .retryCount
    ).toBe(4)
  })
})
