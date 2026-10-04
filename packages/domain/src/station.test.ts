import { describe, expect, it } from "vitest"
import {
  blockStation,
  cancelStation,
  resetStation,
  startStation,
} from "./station"
import {
  active,
  atDepot,
  eventTypes,
  expectRejected,
  inTransit,
  reviewing,
  unwrap,
} from "./testing"

const issue = { kind: "station_failed" as const, detail: "agent crashed" }

describe("startStation", () => {
  it("starts a signaled Station once its workspace exists", () => {
    const { station } = active()
    expect(station.state.status).toBe("active")
  })

  it("rejects starting before the workspace exists", () => {
    expectRejected(startStation(inTransit().station), "invalid_state")
  })

  it("rejects starting a waiting Station", () => {
    expectRejected(startStation(atDepot().station), "invalid_state")
  })
})

describe("blockStation", () => {
  it("retains rejected work, evidence and feedback through an explicit restart", () => {
    const station = { ...reviewing().station, revisionCount: 3, retryCount: 3 }
    const feedback = {
      summary: "Still missing a test",
      findings: ["Add the required assertion"],
    }
    const blocked = unwrap(blockStation(station, [issue], feedback))
    expect(blocked.lastReview).toMatchObject({
      feedback,
      proposal: { evidence: { checks: [{ status: "passed" }] } },
      workspace: { repoId: "s1-repo" },
    })
    const reset = unwrap(resetStation(blocked))
    expect(reset.retryCount).toBe(0)
    expect(reset.revisionCount).toBe(3)
    expect(reset.lastReview).toEqual(blocked.lastReview)
  })
  it("blocks a Station with work in progress", () => {
    const result = blockStation(active().station, [issue])
    expect(unwrap(result).state).toEqual({
      status: "blocked",
      trainId: "t",
      issues: [issue],
    })
    expect(eventTypes(result)).toEqual(["station.blocked"])
  })

  it("rejects blocking without an issue", () => {
    expectRejected(blockStation(active().station, []), "invalid_input")
  })

  it("rejects blocking a waiting Station", () => {
    expectRejected(blockStation(atDepot().station, [issue]), "invalid_state")
  })
})

describe("resetStation", () => {
  it("returns a blocked Station to waiting", () => {
    const blocked = unwrap(blockStation(active().station, [issue]))
    const result = resetStation(blocked)
    expect(unwrap(result).state).toEqual({ status: "waiting" })
    expect(eventTypes(result)).toEqual(["station.reset"])
  })

  it("rejects resetting a Station that is not blocked", () => {
    expectRejected(resetStation(active().station), "invalid_state")
  })
})

describe("cancelStation", () => {
  it("cancels waiting and blocked Stations", () => {
    expect(unwrap(cancelStation(atDepot().station, "rerouted")).state).toEqual({
      status: "cancelled",
      reason: "rerouted",
    })
    const blocked = unwrap(blockStation(active().station, [issue]))
    expect(unwrap(cancelStation(blocked, "rerouted")).state.status).toBe(
      "cancelled"
    )
  })

  it("rejects cancelling a Station with work in progress", () => {
    expectRejected(cancelStation(active().station, "rerouted"), "invalid_state")
  })
})
