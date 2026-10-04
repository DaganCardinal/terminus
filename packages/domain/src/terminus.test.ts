import { describe, expect, it } from "vitest"
import type { Conflict } from "./conflict"
import { beginReturn, clearForTerminus, completeIntegration } from "./terminus"
import {
  accepted,
  active,
  approaching,
  clearContext,
  docked,
  eventTypes,
  expectRejected,
  failingEvidence,
  inTransit,
  passingEvidence,
  reviewing,
  unwrap,
  type World,
} from "./testing"
import type { Train } from "./train"

function allStationsDone(): World {
  return accepted(reviewing(docked(approaching(active(inTransit(accepted()))))))
}

const awaiting = (train: Train): Train => ({
  ...train,
  state: { status: "returning", phase: "awaiting_clearance" },
})
const integrating = (train: Train): Train => ({
  ...train,
  state: { status: "returning", phase: "integrating" },
})

const conflict: Conflict = {
  id: "c1",
  trainIds: ["t"],
  paths: [],
  description: "",
  status: "open",
}

describe("beginReturn", () => {
  it("starts the final leg and asks for clearance", () => {
    const result = beginReturn(allStationsDone())
    expect(unwrap(result).state).toEqual({
      status: "returning",
      phase: "awaiting_clearance",
    })
    expect(eventTypes(result)).toEqual([
      "train.returning",
      "terminus.integration_requested",
    ])
  })

  it("rejects returning with Stations still ahead", () => {
    expectRejected(beginReturn(accepted()), "stations_remaining")
  })

  it("rejects returning unless ready", () => {
    expectRejected(beginReturn(inTransit()), "invalid_state")
  })
})

describe("clearForTerminus", () => {
  it("starts integration when the gate is clear", () => {
    const result = clearForTerminus({
      train: awaiting(allStationsDone().train),
      context: clearContext(),
    })
    expect(unwrap(result).state).toEqual({
      status: "returning",
      phase: "integrating",
    })
    expect(eventTypes(result)).toEqual(["terminus.integration_started"])
  })

  it("does not integrate with an unresolved conflict", () => {
    expectRejected(
      clearForTerminus({
        train: awaiting(allStationsDone().train),
        context: clearContext({ conflicts: [conflict] }),
      }),
      "gate_closed"
    )
  })

  it("rejects a Train that is not awaiting clearance", () => {
    expectRejected(
      clearForTerminus({
        train: integrating(allStationsDone().train),
        context: clearContext(),
      }),
      "invalid_state"
    )
  })
})

describe("completeIntegration", () => {
  const input = (overrides = {}) => ({
    train: integrating(allStationsDone().train),
    mergeCommit: "m1",
    evidence: passingEvidence,
    expectedChecks: ["test"],
    conflicts: [],
    ...overrides,
  })

  it("unloads the Train", () => {
    const result = completeIntegration(input())
    expect(unwrap(result).state).toEqual({
      status: "unloaded",
      mergeCommit: "m1",
    })
    expect(eventTypes(result)).toEqual([
      "terminus.integration_completed",
      "train.unloaded",
    ])
  })

  it("does not unload when project-wide validation failed", () => {
    expectRejected(
      completeIntegration(input({ evidence: failingEvidence })),
      "required_checks_failed"
    )
  })

  it("does not unload when project-wide evidence is missing", () => {
    expectRejected(
      completeIntegration(input({ evidence: { checks: [] } })),
      "required_checks_failed"
    )
  })

  it("does not unload with an unresolved conflict", () => {
    expectRejected(
      completeIntegration(input({ conflicts: [conflict] })),
      "open_conflicts"
    )
  })

  it("rejects a Train that is not integrating", () => {
    expectRejected(
      completeIntegration(input({ train: awaiting(allStationsDone().train) })),
      "invalid_state"
    )
  })
})

describe("deferIntegration", () => {
  it("returns an unpromoted integration to its entry gate", async () => {
    const { deferIntegration } = await import("./terminus")
    const result = deferIntegration(integrating(allStationsDone().train))
    expect(unwrap(result).state).toEqual({
      status: "returning",
      phase: "awaiting_clearance",
    })
    expect(eventTypes(result)).toEqual(["terminus.integration_deferred"])
    expectRejected(
      deferIntegration(awaiting(allStationsDone().train)),
      "invalid_state"
    )
  })
})
