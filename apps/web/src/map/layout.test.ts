import { describe, expect, it } from "vitest"
import type { Line, TrainState } from "@terminus/protocol"
import {
  TRACK_WIDTH,
  layoutNetwork,
  routeShapes,
  isMoving,
  shapeForLine,
  trainDistance,
  type TrainMotion,
} from "./layout"
import { pointOnTrack, type Point } from "./track"

const T0 = Date.parse("2026-10-04T10:00:00.000Z")
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const motion = (
  state: TrainState,
  enteredAt = 0,
  previous: TrainMotion["previous"] = null
): TrainMotion => ({ state, stateEnteredAt: at(enteredAt), previous })

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
  it("uses backend locations for ready, held, docked and reviewing Trains", () => {
    const { routes } = layoutNetwork([line("a")])
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
      { status: "docked", at: "a-s1", from: { kind: "depot" } },
      { status: "reviewing", at: "a-s1", from: { kind: "depot" } },
    ] satisfies TrainState[])
      expect(trainDistance(motion(state), route, T0 + 90_000)).toBe(
        route.stationDistances[1]
      )
    expect(
      trainDistance(
        motion({ status: "ready", at: { kind: "depot" } }),
        route,
        T0
      )
    ).toBe(0)
    expect(pointOnTrack(route.track, 0)).toEqual(route.depot)
  })
  it("eases a Train in transit toward a point short of its Station, never reaching it", () => {
    const { routes } = layoutNetwork([line("a")])
    const route = routes[0]!
    const [first, second] = route.stationDistances as [number, number]
    const moving = motion({
      status: "in_transit",
      from: { kind: "station", stationId: "a-s0" },
      toward: "a-s1",
    })
    const after = (seconds: number) =>
      trainDistance(moving, route, T0 + seconds * 1000)!
    const wait = after(1_000_000)

    expect(after(0)).toBe(first)
    expect(wait).toBeLessThan(second)
    expect(after(60) - first).toBeCloseTo((wait - first) / 2)
    expect(after(120) - first).toBeCloseTo(((wait - first) * 3) / 4)
    // Deterministic, so reloads and polling redraw it in the same place.
    expect(trainDistance(structuredClone(moving), route, T0 + 60_000)).toBe(
      after(60)
    )
    expect(isMoving(moving)).toBe(true)
  })
  it("sends a Train on to its Station only once the work is ready", () => {
    const { routes } = layoutNetwork([line("a")])
    const route = routes[0]!
    const toward = { from: { kind: "depot" as const }, toward: "a-s0" }
    const approaching = motion({ status: "approaching", ...toward }, 30)

    expect(trainDistance(approaching, route, T0 + 30_000)).toBe(
      route.stationDistances[0]
    )
    expect(isMoving(approaching)).toBe(false)
  })
  it("leaves a blocked Train where it stopped", () => {
    const { routes } = layoutNetwork([line("a")])
    const route = routes[0]!
    const ready: TrainState = {
      status: "ready",
      at: { kind: "station", stationId: "a-s0" },
    }
    const blocked: TrainState = {
      status: "blocked",
      issues: [{ kind: "conflict", detail: "Conflict" }],
      resume: ready,
    }
    const moving = motion({
      status: "in_transit",
      from: ready.at,
      toward: "a-s1",
    })
    const stoppedMoving = motion(blocked, 60, {
      state: moving.state,
      enteredAt: moving.stateEnteredAt,
    })
    const stoppedDocked = motion(blocked, 60, {
      state: { status: "docked", from: ready.at, at: "a-s1" },
      enteredAt: at(0),
    })

    expect(trainDistance(stoppedMoving, route, T0 + 600_000)).toBe(
      trainDistance(moving, route, T0 + 60_000)
    )
    expect(trainDistance(stoppedDocked, route, T0 + 600_000)).toBe(
      route.stationDistances[1]
    )
    // Without a recorded previous state, it falls back to where it resumes.
    expect(trainDistance(motion(blocked), route, T0)).toBe(
      route.stationDistances[0]
    )
    expect(isMoving(stoppedMoving)).toBe(false)
  })
  it("removes terminal Trains from track and parks returning ones past the last Station", () => {
    const { routes } = layoutNetwork([line("a")])
    const route = routes[0]!
    expect(
      trainDistance(
        motion({ status: "unloaded", mergeCommit: "abc" }),
        route,
        T0
      )
    ).toBeNull()
    expect(
      trainDistance(
        motion({ status: "siding", reason: "Abandoned" }),
        route,
        T0
      )
    ).toBeNull()
    expect(
      trainDistance(
        motion({ status: "returning", phase: "awaiting_clearance" }),
        route,
        T0
      )
    ).toBeGreaterThan(route.stationDistances.at(-1)!)
  })
  it("projects approval holds into the review yard while other holds remain on track", () => {
    const route = layoutNetwork([line("a")]).routes[0]!
    const resume = {
      status: "returning" as const,
      phase: "awaiting_clearance" as const,
    }
    expect(
      trainDistance(
        motion({
          status: "held",
          resume,
          reasons: [{ kind: "awaiting_user_approval", trainCommit: "head" }],
        }),
        route,
        T0
      )
    ).toBeNull()
    expect(
      trainDistance(
        motion({
          status: "held",
          resume,
          reasons: [{ kind: "user_hold", holdId: "h" }],
        }),
        route,
        T0
      )
    ).toBeGreaterThan(route.stationDistances.at(-1)!)
  })
  it("joins every change of direction with a curve, never a hard corner", () => {
    for (const count of [1, 3, 6, 8, 13, 24]) {
      const { routes } = layoutNetwork(
        Array.from({ length: count }, (_, i) => line(`line-${i}`, (i % 6) + 1))
      )
      for (const { track } of routes) {
        for (let i = 1; i < track.pieces.length; i++) {
          const piece = track.pieces[i]!
          const previous = track.pieces[i - 1]!
          if (piece.kind === "arc") {
            expect(piece.radius).toBeGreaterThanOrEqual(20)
            continue
          }
          if (previous.kind !== "line") continue
          const heading = (p: { from: Point; to: Point }) =>
            Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x)
          expect(heading(piece)).toBeCloseTo(heading(previous), 6)
        }
      }
    }
  })
  it("places Stations only on straight horizontal track, clear of curves", () => {
    for (const count of [1, 4, 6, 12]) {
      const { routes } = layoutNetwork(
        Array.from({ length: count }, (_, i) => line(`line-${i}`, (i % 7) + 1))
      )
      for (const route of routes) {
        route.stationDistances.forEach((distance, i) => {
          const index = route.track.pieces.findIndex(
            (p) => distance >= p.start && distance <= p.start + p.length
          )
          const piece = route.track.pieces[index]!
          expect(piece.kind).toBe("line")
          if (piece.kind !== "line") return
          expect(piece.from.y).toBeCloseTo(piece.to.y, 6)
          expect(route.stations[i]!.y).toBeCloseTo(piece.from.y, 6)
          const before = route.track.pieces[index - 1]
          const after = route.track.pieces[index + 1]
          if (before?.kind === "arc")
            expect(distance - piece.start).toBeGreaterThanOrEqual(20)
          if (after?.kind === "arc")
            expect(
              piece.start + piece.length - distance
            ).toBeGreaterThanOrEqual(20)
        })
        const gaps = route.stations
          .slice(1)
          .map((p, i) => Math.abs(p.x - route.stations[i]!.x))
        for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(150)
      }
    }
  })
  it("never crosses Lines or makes short jogs before Terminus", () => {
    const crosses = (a: Point, b: Point, c: Point, d: Point) => {
      const side = (p: Point, q: Point, r: Point) =>
        Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
      return (
        side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
      )
    }
    for (const count of [2, 3, 6, 8, 12, 24]) {
      const { routes } = layoutNetwork(
        Array.from({ length: count }, (_, i) => line(`line-${i}`, (i % 5) + 1))
      )
      for (const route of routes)
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1]!,
            b = route.points[i]!
          if (Math.abs(a.y - b.y) > 0.01)
            expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(40)
        }
      let crossings = 0
      for (let r = 0; r < routes.length; r++)
        for (let s = r + 1; s < routes.length; s++) {
          // The last segment of each route runs beneath the Terminus marker.
          const a = routes[r]!.points.slice(0, -1)
          const b = routes[s]!.points.slice(0, -1)
          for (let i = 1; i < a.length; i++)
            for (let j = 1; j < b.length; j++)
              if (crosses(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) crossings++
        }
      expect(crossings).toBe(0)
      // Parallel approach lanes keep a clear gap between their strokes.
      const samples = routes.map((route) =>
        Array.from({ length: 80 }, (_, i) =>
          pointOnTrack(
            route.track,
            route.trackEnd +
              ((route.track.length - route.trackEnd - 60) * i) / 79
          )
        )
      )
      let closest = Infinity
      for (let r = 0; r < samples.length; r++)
        for (let s = r + 1; s < samples.length; s++)
          for (const p of samples[r]!)
            for (const q of samples[s]!)
              closest = Math.min(closest, Math.hypot(p.x - q.x, p.y - q.y))
      expect(closest).toBeGreaterThan(TRACK_WIDTH)
    }
  })
})
