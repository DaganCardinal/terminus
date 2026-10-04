import { describe, expect, it } from "vitest"
import { removeStation, requestStationRemoval } from "./station-removal"
import { depart } from "./journey"
import { nextStation } from "./line"
import { beginReturn } from "./terminus"
import { blockTrain } from "./train"
import {
  atDepot,
  clearContext,
  expectRejected,
  manifest,
  unwrap,
} from "./testing"

const input = () => ({ ...atDepot(), reason: "Redundant verification" })

describe("Station removal", () => {
  it("preserves the Line and skips the cancelled Station on departure", () => {
    const world = input()
    const result = removeStation(world)
    const removed = unwrap(result)
    const stations = [removed.station, world.stations[1]!]
    expect(world.line.stationIds).toEqual(["s1", "s2"])
    expect(removed.train.headCommit).toBe(world.train.headCommit)
    expect(removed.train.carIds).toEqual([])
    expect(nextStation(stations)?.id).toBe("s2")
    expect(
      unwrap(
        depart({
          ...world,
          train: removed.train,
          stations,
          context: clearContext(),
        })
      ).station.id
    ).toBe("s2")
    expect(result.ok && result.events).toEqual([
      { type: "station.cancelled", stationId: "s1", reason: world.reason },
    ])
  })
  it("can remove the last Station and return to Terminus", () => {
    const world = { ...atDepot(1), reason: "No work required" }
    const removed = unwrap(removeStation(world))
    expect(
      unwrap(
        beginReturn({
          ...world,
          train: removed.train,
          stations: [removed.station],
        })
      ).state.status
    ).toBe("returning")
  })
  it("refuses unfinished dependents on any Line and never rewrites their manifests", () => {
    const world = input()
    for (const status of ["waiting", "active", "blocked"] as const) {
      const dependent = {
        ...world.stations[1]!,
        lineId: "other-line",
        manifest: manifest({ dependencies: [world.station.id] }),
        state:
          status === "waiting"
            ? { status }
            : status === "blocked"
              ? { status, trainId: "other-train", issues: [] }
              : {
                  status,
                  trainId: "other-train",
                  workspace: { repoId: "repo", baseCommit: "base" },
                },
      }
      expectRejected(
        removeStation({ ...world, stations: [world.station, dependent] }),
        "invalid_input"
      )
      expect(dependent.manifest.dependencies).toEqual([world.station.id])
    }
    expect(
      unwrap(
        removeStation({
          ...world,
          stations: [
            world.station,
            {
              ...world.stations[1]!,
              manifest: manifest({ dependencies: [world.station.id] }),
              state: { status: "cancelled", reason: "Discarded" },
            },
          ],
        })
      ).station.state.status
    ).toBe("cancelled")
  })
  it("refuses active, accepted, or already cancelled work, blank reasons and wrong ownership", () => {
    const world = input()
    for (const state of [
      { status: "signaled" as const, trainId: world.train.id, workspace: null },
      { status: "complete" as const, trainId: world.train.id, carId: "car" },
      { status: "cancelled" as const, reason: "Earlier removal" },
    ])
      expectRejected(
        removeStation({ ...world, station: { ...world.station, state } }),
        "invalid_state"
      )
    expectRejected(removeStation({ ...world, reason: " " }), "invalid_input")
    expectRejected(
      removeStation({
        ...world,
        station: { ...world.station, lineId: "other" },
      }),
      "invalid_input"
    )
    expectRejected(
      removeStation({
        ...world,
        train: {
          ...world.train,
          state: { status: "unloaded", mergeCommit: "merged" },
        },
      }),
      "invalid_state"
    )
  })
  it("clears only the rejected Station gate, preserving unrelated blockers", () => {
    const world = input()
    const train = unwrap(
      blockTrain(world.train, [
        { kind: "station_change_required", detail: "No changes declared" },
      ])
    )
    expect(unwrap(removeStation({ ...world, train })).train.state.status).toBe(
      "ready"
    )
    expect(
      unwrap(removeStation({ ...world, train, station: world.stations[1]! }))
        .train.state.status
    ).toBe("blocked")
    const conflict = unwrap(
      blockTrain(world.train, [{ kind: "conflict", detail: "Unresolved" }])
    )
    expect(
      unwrap(removeStation({ ...world, train: conflict })).train.state.status
    ).toBe("blocked")
  })
  it("discards a blocked Station without accepting its candidate and clears its review blocker", () => {
    const world = input()
    const issues = [{ kind: "review_escalated" as const, detail: "Empty diff" }]
    const train = unwrap(blockTrain(world.train, issues))
    const station = {
      ...world.station,
      state: { status: "blocked" as const, trainId: train.id, issues },
    }
    const removed = unwrap(
      removeStation({
        ...world,
        train,
        station,
        stations: [station, world.stations[1]!],
      })
    )
    expect(removed.train.state.status).toBe("ready")
    expect(removed.train.headCommit).toBe(train.headCommit)
    expect(removed.train.carIds).toEqual([])
  })
  it("requests removal without changing Train state and avoids duplicate requests", () => {
    const world = input()
    const result = requestStationRemoval(world)
    const station = unwrap(result)
    expect(station.state.status).toBe("waiting")
    expect(station.removalRequest).toEqual({ reason: world.reason })
    expect(result.ok && result.events[0]?.type).toBe(
      "station.removal_requested"
    )
    expect(requestStationRemoval({ ...world, station })).toMatchObject({
      ok: true,
      events: [],
    })
  })
})
