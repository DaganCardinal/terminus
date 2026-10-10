import { describe, expect, it } from "vitest"
import {
  blockStation,
  cancelStation,
  resetStation,
  startStation,
  requestStationStop,
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

describe("requestStationStop", () => {
  it("records user intent without changing lifecycle state, and blocks a subsequent start", () => {
    const original = active().station
    if (original.state.status !== "active")
      throw new Error("Expected active Station")
    const station = {
      ...original,
      state: { ...original.state, status: "signaled" as const },
    }
    const result = requestStationStop(station, "Emergency Brake")
    const stopped = unwrap(result)
    expect(stopped.state).toEqual(station.state)
    expect(eventTypes(result)).toEqual(["station.stop_requested"])
    expectRejected(startStation(stopped), "invalid_state")
    expect(requestStationStop(stopped, "Emergency Brake")).toMatchObject({
      ok: true,
      events: [],
    })
  })
  it("clears the request only through explicit restart and preserves lifetime history", () => {
    const stopped = unwrap(
      requestStationStop(
        { ...active().station, revisionCount: 2, runRetries: 3 },
        "Emergency Brake"
      )
    )
    const reset = unwrap(
      resetStation(
        unwrap(
          blockStation(stopped, [
            { kind: "needs_user", detail: "Emergency Brake" },
          ])
        )
      )
    )
    expect(reset.stopRequest).toBeUndefined()
    expect(reset.revisionCount).toBe(2)
    expect(reset.runRetries).toBe(3)
  })
  it("rejects empty reasons and Stations without an unfinished run", () => {
    expectRejected(requestStationStop(active().station, " "), "invalid_input")
    expectRejected(
      requestStationStop(atDepot().station, "Emergency Brake"),
      "invalid_state"
    )
  })
})

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
