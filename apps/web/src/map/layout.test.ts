import { describe, expect, it } from "vitest"
import type { Line, TrainState } from "@terminus/protocol"
import { layoutNetwork, routeShapes, shapeForLine, trainPoint } from "./layout"

const line = (id: string, count = 3): Line => ({
  id,
  networkId: "network",
  name: id,
  stationIds: Array.from({ length: count }, (_, i) => `${id}-s${i}`),
})

describe("network map projection", () => {
  it("assigns all six shapes from Line identity and preserves them through reloads and additions", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(`line-${i}`))
    expect(new Set(lines.map((l) => shapeForLine(l.id)))).toEqual(
      new Set(routeShapes)
    )
    const before = layoutNetwork(lines.slice(0, 6)).routes.map((r) => r.shape)
    expect(new Set(before).size).toBe(6)
    expect(
      layoutNetwork(structuredClone(lines.slice(0, 6))).routes.map(
        (r) => r.shape
      )
    ).toEqual(before)
    expect(
      layoutNetwork(lines.slice(0, 8))
        .routes.slice(0, 6)
        .map((r) => r.shape)
    ).toEqual(before)
  })
  it("keeps stations in travel order, geometry in bounds and bends on the transit grid", () => {
    for (const count of [1, 2, 6, 12, 24]) {
      const layout = layoutNetwork(
        Array.from({ length: count }, (_, i) => line(`line-${i}`, (i % 7) + 1))
      )
      for (const route of layout.routes) {
        for (const p of [...route.points, ...route.stations]) {
          expect(p.x).toBeGreaterThanOrEqual(0)
          expect(p.x).toBeLessThanOrEqual(layout.width)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThanOrEqual(layout.height)
        }
        for (let i = 1; i < route.points.length; i++) {
          const dx = Math.abs(route.points[i]!.x - route.points[i - 1]!.x),
            dy = Math.abs(route.points[i]!.y - route.points[i - 1]!.y)
          expect(dx < 0.001 || dy < 0.001 || Math.abs(dx - dy) < 0.001).toBe(
            true
          )
        }
        const distances = route.stations.map((p) =>
          Math.abs(p.x - route.depot.x)
        )
        expect(distances).toEqual([...distances].sort((a, b) => a - b))
        expect(route.points.at(-1)!.x).toEqual(layout.hub.x)
      }
    }
  })
  it("gives all six shapes different track geometry", () => {
    const byShape = new Map()
    for (let i = 0; i < 100; i++) {
      const l = line(`line-${i}`)
      byShape.set(
        shapeForLine(l.id),
        layoutNetwork([l]).routes[0]!.stationTrack
      )
    }
    expect(
      new Set([...byShape.values()].map((p) => JSON.stringify(p))).size
    ).toBe(6)
  })
  it("uses backend locations for ready, held, blocked, docked and reviewing Trains", () => {
    const { routes, hub } = layoutNetwork([line("a")])
    const route = routes[0]!
    const ready: TrainState = {
      status: "ready",
      at: { kind: "station", stationId: "a-s1" },
    }
    for (const state of [
      ready,
      {
        status: "held",
        reasons: [{ kind: "dependency", stationId: "elsewhere" }],
        resume: ready,
      },
      {
        status: "blocked",
        issues: [{ kind: "conflict", detail: "Conflict" }],
        resume: ready,
      },
      { status: "docked", at: "a-s1", from: { kind: "depot" } },
      { status: "reviewing", at: "a-s1", from: { kind: "depot" } },
    ] satisfies TrainState[])
      expect(trainPoint(state, route, hub)).toEqual(route.stations[1])
    expect(
      trainPoint({ status: "ready", at: { kind: "depot" } }, route, hub)
    ).toEqual(route.depot)
  })
  it("shows lifecycle phases without simulating progress and removes terminal Trains from track", () => {
    const { routes, hub } = layoutNetwork([line("a")])
    const route = routes[0]!
    const moving: TrainState = {
      status: "in_transit",
      from: { kind: "depot" },
      toward: "a-s0",
    }
    expect(trainPoint(moving, route, hub)).not.toEqual(route.stations[0])
    expect(trainPoint(moving, route, hub)).toEqual(
      trainPoint(structuredClone(moving), route, hub)
    )
    expect(
      trainPoint({ ...moving, status: "approaching" }, route, hub)
    ).not.toEqual(trainPoint(moving, route, hub))
    expect(
      trainPoint({ status: "unloaded", mergeCommit: "abc" }, route, hub)
    ).toBeNull()
    expect(
      trainPoint({ status: "siding", reason: "Abandoned" }, route, hub)
    ).toBeNull()
    expect(
      trainPoint(
        { status: "returning", phase: "awaiting_clearance" },
        route,
        hub
      )
    ).not.toEqual(hub)
  })
})
