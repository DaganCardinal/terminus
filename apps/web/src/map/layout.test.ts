import { describe, expect, it } from "vitest"
import {
  lineIdentities,
  type EventEnvelope,
  type Line,
  type TrainState,
} from "@terminus/protocol"
import {
  HUB_RADIUS,
  TRACK_WIDTH,
  clearingBlock,
  layoutNetwork,
  lineColor,
  routeShapes,
  isMoving,
  trainDistance,
  trainStops,
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
    expect(
      new Set(lines.map((l) => layoutNetwork([l]).routes[0]!.shape))
    ).toEqual(new Set(routeShapes))
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
  it("gives a finished Line's row, number and colour to the next Line laid", () => {
    const [a, b, c] = [line("a"), line("b"), line("c")]
    const view = (
      lineId: string,
      status: TrainState["status"],
      at: string
    ) => ({
      train: { lineId, state: { status } },
      stateEnteredAt: at,
    })
    const identities = lineIdentities({
      network: { createdAt: at(0) },
      lines: [a, b, c],
      lineCreatedAt: { a: at(1), b: at(1), c: at(10) },
      trains: [
        view("a", "unloaded", at(5)),
        view("b", "in_transit", at(1)),
        view("c", "ready", at(10)),
      ],
    })
    const before = layoutNetwork([a, b]).routes
    const after = layoutNetwork([b, c], identities).routes
    const routeOf = (routes: typeof before, id: string) =>
      routes.find((r) => r.line.id === id)!
    expect(routeOf(after, "c")).toMatchObject({
      number: 1,
      side: routeOf(before, "a").side,
      color: routeOf(before, "a").color,
    })
    expect(routeOf(after, "b")).toMatchObject({
      number: 2,
      side: routeOf(before, "b").side,
      color: lineColor(identities.get("b")!.color),
    })
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
      const route = layoutNetwork([l]).routes[0]!
      byShape.set(route.shape, route.stationTrack)
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
  it("runs unloaded Trains into Terminus and removes sided ones", () => {
    const { routes } = layoutNetwork([line("a")])
    const route = routes[0]!
    expect(
      trainDistance(
        motion({ status: "unloaded", mergeCommit: "abc" }),
        route,
        T0
      )
    ).toBe(route.track.length)
    expect(
      trainDistance(
        motion({ status: "siding", reason: "Abandoned" }),
        route,
        T0
      )
    ).toBeNull()
  })
  it("runs a returning Train from its last Station toward Terminus like any other run", () => {
    const route = layoutNetwork([line("a")]).routes[0]!
    const last = route.stationDistances.at(-1)!
    const returning = motion(
      { status: "returning", phase: "awaiting_clearance" },
      0,
      {
        state: { status: "reviewing", at: "a-s2", from: { kind: "depot" } },
        enteredAt: at(-30),
      }
    )
    const after = (seconds: number) =>
      trainDistance(returning, route, T0 + seconds * 1000)!
    const wait = after(1_000_000)

    expect(after(0)).toBe(last)
    expect(after(60) - last).toBeCloseTo((wait - last) / 2)
    // It waits outside Terminus, as a Train waits short of a Station.
    expect(wait).toBeLessThan(route.track.length - HUB_RADIUS)
    expect(isMoving(returning)).toBe(true)
  })
  it("holds Trains awaiting approval on track, where they stopped on their way to Terminus", () => {
    const route = layoutNetwork([line("a")]).routes[0]!
    const resume = {
      status: "returning" as const,
      phase: "awaiting_clearance" as const,
    }
    const returning = motion(resume)
    const held = (
      reasons: Extract<TrainState, { status: "held" }>["reasons"]
    ) =>
      trainDistance(
        motion({ status: "held", resume, reasons }, 60, {
          state: resume,
          enteredAt: at(0),
        }),
        route,
        T0 + 600_000
      )

    expect(
      held([{ kind: "awaiting_user_approval", trainCommit: "head" }])
    ).toBe(trainDistance(returning, route, T0 + 60_000))
    expect(held([{ kind: "user_hold", holdId: "h" }])).toBeGreaterThan(
      route.stationDistances.at(-1)!
    )
    // Released, it sets off again from its last Station.
    const released = motion(resume, 600, {
      state: { status: "held", resume, reasons: [] },
      enteredAt: at(60),
    })
    expect(trainDistance(released, route, T0 + 600_000)).toBe(
      route.stationDistances.at(-1)
    )
    expect(isMoving(released)).toBe(true)
  })
  it("leaves a cleared Train where its block stopped it until the block resolves", () => {
    const route = layoutNetwork([line("a")]).routes[0]!
    let seq = 0
    const event = (
      seconds: number,
      event: EventEnvelope["event"]
    ): EventEnvelope => ({
      seq: ++seq,
      networkId: "network",
      occurredAt: at(seconds),
      event,
    })
    const trainId = "train"
    const departed = (seconds: number, stationId: string) =>
      event(seconds, { type: "train.departed", trainId, stationId })
    const blocked = (seconds: number) =>
      event(seconds, {
        type: "train.blocked",
        trainId,
        issues: [{ kind: "conflict", detail: "Conflict" }],
      })
    const cleared = (seconds: number) =>
      event(seconds, { type: "train.cleared", trainId })
    const ready: TrainState = {
      status: "ready",
      at: { kind: "station", stationId: "a-s0" },
    }
    const rerun: TrainState = {
      status: "in_transit",
      from: ready.at,
      toward: "a-s1",
    }
    const place = (events: EventEnvelope[], state: TrainState) => {
      const m = {
        ...motion(state, 200),
        stop: trainStops(events).get(trainId) ?? null,
      }
      return {
        distance: trainDistance(m, route, T0 + 400_000),
        clearing: clearingBlock(m),
      }
    }
    const stoppedAt = trainDistance(
      motion({ status: "in_transit", from: ready.at, toward: "a-s1" }),
      route,
      T0 + 60_000
    )

    // Blocked in transit, cleared, and running the Station again.
    const history = [departed(0, "a-s1"), blocked(60), cleared(100)]
    expect(place(history, ready)).toEqual({
      distance: stoppedAt,
      clearing: true,
    })
    const again = [...history, departed(150, "a-s1")]
    expect(place(again, rerun)).toEqual({ distance: stoppedAt, clearing: true })
    // Blocked again, it still has not moved.
    expect(place([...again, blocked(300)], rerun).distance).toBe(stoppedAt)
    // Once the work is ready, it runs on to the Station.
    const ready1 = [
      ...again,
      event(300, { type: "train.approaching", trainId, stationId: "a-s1" }),
    ]
    expect(
      place(ready1, { status: "approaching", from: ready.at, toward: "a-s1" })
    ).toEqual({ distance: route.stationDistances[1], clearing: false })

    // Blocked at a Station, it stays there while it runs that Station again.
    const docked = [
      departed(0, "a-s1"),
      event(50, { type: "train.arrived", trainId, stationId: "a-s1" }),
      blocked(60),
      cleared(100),
      departed(150, "a-s1"),
    ]
    expect(place(docked, rerun)).toEqual({
      distance: route.stationDistances[1],
      clearing: true,
    })
    // Departing for a different Station is an ordinary run.
    const onward = [
      departed(0, "a-s1"),
      event(50, { type: "train.arrived", trainId, stationId: "a-s1" }),
      blocked(60),
      cleared(100),
      departed(150, "a-s2"),
    ]
    expect(
      place(onward, {
        status: "in_transit",
        from: { kind: "station", stationId: "a-s1" },
        toward: "a-s2",
      }).clearing
    ).toBe(false)
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

it("routes a receiver through the source Station on its own lane and places pickup visits in order", () => {
  const source = line("source"),
    receiver = line("receiver", 2)
  receiver.stops = [
    { kind: "station", stationId: receiver.stationIds[0]! },
    { kind: "crossing", crossingId: "x", stationId: source.stationIds[1]! },
    { kind: "station", stationId: receiver.stationIds[1]! },
  ]
  const result = layoutNetwork([source, receiver]),
    [a, b] = result.routes
  const visit = b!.stations[1]!
  expect(visit.x).toBe(a!.stations[1]!.x)
  expect(Math.abs(visit.y - a!.stations[1]!.y)).toBe(16)
  expect(result.interchanges).toEqual([
    {
      stationId: source.stationIds[1],
      at: a!.stations[1],
      lanes: [{ lineId: "receiver", crossingId: "x", point: visit }],
    },
  ])
  expect(b!.stationDistances[0]).toBeLessThan(b!.stationDistances[1]!)
  expect(b!.stationDistances[1]).toBeLessThan(b!.stationDistances[2]!)
  const d = trainDistance(
    motion({
      status: "docked",
      from: { kind: "station", stationId: receiver.stationIds[0]! },
      at: source.stationIds[1]!,
      crossingId: "x",
    }),
    b!,
    T0
  )
  expect(pointOnTrack(b!.track, d!)).toEqual(visit)
  expect(layoutNetwork(structuredClone([source, receiver]))).toEqual(result)
})

it("projects independent Junctions with their own approach lanes and outgoing routes on the trunk", () => {
  const lines: Line[] = []
  for (const id of ["j1", "j2"]) {
    lines.push(
      {
        ...line(`${id}-a`, 2),
        destination: { kind: "junction", junctionId: id },
      },
      {
        ...line(`${id}-b`, 1),
        destination: { kind: "junction", junctionId: id },
      },
      {
        ...line(`${id}-out`, id === "j1" ? 1 : 0),
        origin: { kind: "junction", junctionId: id },
      }
    )
  }
  const layout = layoutNetwork(lines)
  for (const id of ["j1", "j2"]) {
    const routes = layout.routes.filter((r) => r.line.id.startsWith(id)),
      [a, b, out] = routes
    const junction = layout.junctions.find((j) => j.id === id)!
    for (const input of [a!, b!]) {
      const end = input.points.at(-1)!
      expect(end.x).toBe(junction.point.x)
      expect(Math.abs(end.y - junction.point.y)).toBeLessThan(
        junction.halfHeight
      )
    }
    expect(a!.points.at(-1)).not.toEqual(b!.points.at(-1))
    expect(out!.points[0]).toEqual(junction.point)
    // The outgoing Line continues straight on from its trunk input.
    expect(a!.points.at(-1)!.y).toBe(junction.point.y)
    expect(out!.points.at(-1)!.x).toBe(layout.hub.x)
    expect(
      trainDistance(
        motion({ status: "ready", at: { kind: "junction", junctionId: id } }),
        out!,
        T0
      )
    ).toBe(0)
  }
  expect(layoutNetwork(structuredClone(lines))).toEqual(layout)
})

describe("Crossing and Junction map projection", () => {
  const junction = (id: string) => ({
    kind: "junction" as const,
    junctionId: id,
  })
  const cross = (lineId: string, i: number, k = 0) => ({
    kind: "crossing" as const,
    crossingId: `x-${lineId}-${i}-${k}`,
    stationId: `${lineId}-s${i}`,
  })
  const own = (l: Line, i: number) => ({
    kind: "station" as const,
    stationId: l.stationIds[i]!,
  })
  /** Networks that previously drew Lines along each other's track. */
  const networks: Record<string, () => Line[]> = {
    "receiver below": () => {
      const a = line("a"),
        b = line("b", 2)
      b.stops = [own(b, 0), cross("a", 1), own(b, 1)]
      return [a, b]
    },
    "receiver above, two rows away": () => {
      const b = line("b", 2),
        m = line("m"),
        a = line("a")
      b.stops = [own(b, 0), cross("a", 1), own(b, 1)]
      return [b, m, a]
    },
    "crossing as last and first stop": () => {
      const a = line("a"),
        b = line("b", 2),
        c = line("c", 1)
      b.stops = [own(b, 0), own(b, 1), cross("a", 2)]
      c.stops = [cross("a", 0), own(c, 0)]
      return [a, b, c]
    },
    "one source Station, several receivers": () => {
      const a = line("a"),
        b = line("b", 2),
        c = line("c", 2),
        d = line("d", 2)
      b.stops = [own(b, 0), cross("a", 1), own(b, 1)]
      c.stops = [own(c, 0), cross("a", 1), own(c, 1)]
      d.stops = [cross("a", 1), own(d, 0), own(d, 1)]
      return [b, a, c, d]
    },
    "late pickup past unvisited Stations": () => {
      const a = line("a", 6),
        b = line("b", 2)
      b.stops = [own(b, 0), cross("a", 4), own(b, 1)]
      return [a, b]
    },
    "chained and stacked visits in one column": () => {
      const l = Array.from({ length: 8 }, (_, i) => line(`l${i}`, 3))
      l[1]!.stops = [
        own(l[1]!, 0),
        cross("l0", 1),
        own(l[1]!, 1),
        own(l[1]!, 2),
      ]
      l[3]!.stops = [
        own(l[3]!, 0),
        cross("l2", 1),
        own(l[3]!, 1),
        own(l[3]!, 2),
      ]
      l[6]!.stops = [
        own(l[6]!, 0),
        cross("l1", 0),
        own(l[6]!, 1),
        own(l[6]!, 2),
      ]
      l[7]!.stops = [
        own(l[7]!, 0),
        cross("l6", 1),
        cross("l5", 2),
        own(l[7]!, 1),
        own(l[7]!, 2),
      ]
      return l
    },
    "contradictory pickup orders": () => {
      const a = line("a", 2),
        b = line("b", 2),
        c = line("c", 1),
        d = line("d", 1)
      c.stops = [own(c, 0), cross("a", 1), cross("b", 1)]
      d.stops = [own(d, 0), cross("b", 1), cross("a", 1)]
      return [a, b, c, d]
    },
    "Junctions with plain Lines between their inputs": () => [
      { ...line("a", 2), destination: junction("j") },
      line("p", 3),
      { ...line("b", 1), destination: junction("j") },
      { ...line("c", 4), destination: junction("j") },
      { ...line("o", 2), origin: junction("j") },
      { ...line("k", 1), destination: junction("k") },
      { ...line("ko", 0), origin: junction("k") },
      line("q", 2),
    ],
    "Crossings inside a Junction and from its outgoing Line": () => {
      const a = { ...line("a", 3), destination: junction("j") }
      const b = { ...line("b", 2), destination: junction("j") }
      const o = { ...line("o", 3), origin: junction("j") }
      const p = line("p", 2)
      b.stops = [own(b, 0), cross("a", 1), own(b, 1)]
      p.stops = [own(p, 0), cross("o", 1), own(p, 1)]
      return [o, p, a, b]
    },
  }

  for (const [name, build] of Object.entries(networks))
    it(`keeps Lines apart except where they meet: ${name}`, () => {
      const layout = layoutNetwork(build())
      const samples = layout.routes.map((route) =>
        Array.from({ length: Math.ceil(route.track.length / 4) + 1 }, (_, i) =>
          pointOnTrack(route.track, i * 4)
        )
      )
      const inside = (p: Point) =>
        (Math.abs(p.x - layout.hub.x) <= 42 &&
          Math.abs(p.y - layout.hub.y) <= layout.hubHalfHeight + 2) ||
        layout.junctions.some(
          (j) =>
            Math.abs(p.x - j.point.x) <= 30 &&
            Math.abs(p.y - j.point.y) <= j.halfHeight + 2
        )
      for (let r = 0; r < samples.length; r++)
        for (let s = r + 1; s < samples.length; s++) {
          // Strokes may only touch where two Lines cross: a short contact.
          let run = 0
          for (const p of samples[r]!) {
            const touching =
              !inside(p) &&
              samples[s]!.some(
                (q) => Math.hypot(p.x - q.x, p.y - q.y) < TRACK_WIDTH
              )
            run = touching ? run + 4 : 0
            expect(
              run,
              `${layout.routes[r]!.line.id} on ${layout.routes[s]!.line.id} at ${p.x},${p.y}`
            ).toBeLessThanOrEqual(20)
          }
        }
      for (const [r, route] of layout.routes.entries()) {
        const visited = new Set(route.stopStationIds)
        for (const other of layout.routes)
          other.line.stationIds.forEach((id) => {
            if (visited.has(id)) return
            const station = other.stations[other.stopStationIds!.indexOf(id)]!
            expect(
              samples[r]!.every(
                (p) => Math.hypot(p.x - station.x, p.y - station.y) > 14
              ),
              `${route.line.id} through ${id}`
            ).toBe(true)
          })
        // Always toward Terminus, through Stations on straight level track.
        for (let i = 1; i < route.points.length; i++)
          expect(route.points[i]!.x).toBeGreaterThanOrEqual(
            route.points[i - 1]!.x
          )
        for (const piece of route.track.pieces)
          if (piece.kind === "arc")
            expect(piece.radius).toBeGreaterThanOrEqual(20)
        for (const distance of route.stationDistances) {
          const piece = route.track.pieces.find(
            (p) => distance >= p.start && distance <= p.start + p.length
          )!
          expect(piece.kind).toBe("line")
          if (piece.kind === "line")
            expect(piece.from.y).toBeCloseTo(piece.to.y, 6)
        }
        for (const p of [...route.points, route.bullet!])
          expect(
            p.x >= 0 && p.y >= 0 && p.x <= layout.width && p.y <= layout.height
          ).toBe(true)
      }
    })
})

it("turns a pickup that contradicts another route's order into a remote pickup on the receiver's row", () => {
  const a = line("a", 2),
    b = line("b", 2),
    c = line("c", 1),
    d = line("d", 1)
  const visit = (lineId: string, i: number) => ({
    kind: "crossing" as const,
    crossingId: `${lineId}-${i}`,
    stationId: `${lineId}-s${i}`,
  })
  c.stops = [
    { kind: "station", stationId: "c-s0" },
    visit("a", 1),
    visit("b", 1),
  ]
  d.stops = [
    { kind: "station", stationId: "d-s0" },
    visit("b", 1),
    visit("a", 1),
  ]
  const layout = layoutNetwork([a, b, c, d])
  const remote = layout.interchanges.flatMap((i) =>
    i.lanes.filter((lane) => lane.remote)
  )
  expect(remote).toHaveLength(1)
  const receiver = layout.routes.find((r) => r.line.id === remote[0]!.lineId)!
  expect(remote[0]!.point.y).toBe(receiver.depot.y)
  expect(receiver.stations).toContainEqual(remote[0]!.point)
})
