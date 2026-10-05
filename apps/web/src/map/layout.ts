import type { Line, TrainState, TrainView } from "@terminus/protocol"
import {
  pointOnTrack,
  roundTrack,
  straightRuns,
  type Point,
  type Track,
} from "./track"

export type { Point }
export const routeShapes = [
  "direct",
  "elbow",
  "dogleg",
  "staircase",
  "sweep",
  "offset",
] as const
export type RouteShape = (typeof routeShapes)[number]

/** Dispatcher IDs contain random UUID entropy. Using it as a seed gives each
 * newly laid Line a random shape that survives polling, reloads and browsers.
 * Geometry is presentation only; it never becomes orchestration state. */
export function shapeForLine(
  id: string,
  choices: readonly RouteShape[] = routeShapes
): RouteShape {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return choices[(hash >>> 0) % choices.length]!
}

const colors = [
  "#ce3548",
  "#176ab5",
  "#008477",
  "#8653a1",
  "#b86b08",
  "#bf497b",
  "#55762a",
  "#407e92",
]
export function lineColor(line: Pick<Line, "name">, index: number): string {
  const named: Record<string, string> = {
    red: colors[0]!,
    blue: colors[1]!,
    green: colors[2]!,
    purple: colors[3]!,
    orange: colors[4]!,
  }
  return (
    named[line.name.split(" ")[0]!.toLowerCase()] ??
    colors[index % colors.length]!
  )
}

// Diagram units. Curves follow transit-map practice: a radius of roughly
// three to four line widths, concentric where lines run in parallel.
export const TRACK_WIDTH = 8
export const HUB_RADIUS = 40
const CORNER_RADIUS = 28
const LANE_GAP = 16
const MARGIN_X = 132
const DEPOT_GAP = 104
const STATION_SPACING = 168
const STATION_CLEARANCE = 22
const TRACK_TAIL = 76
const ROW_CLEARANCE = 210
const LABEL_ROOM = 112
const TRAIN_ROOM = 84
const HUB_ENTRY = 24
const HUB_LABEL_HALF_WIDTH = 100
/** Route bullet offset from the depot, and half the width of its name. */
export const BULLET_OFFSET = 46
const BULLET_LABEL_HALF_WIDTH = 64
const PADDING = 24
const TAN_EIGHTH = Math.tan(Math.PI / 8)

/** Station track profiles: horizontal runs joined by 45° or 90° bends. */
function profile(shape: RouteShape, span: number): Point[] {
  const p = (x: number, y: number) => ({ x, y })
  switch (shape) {
    case "direct":
      return [p(0, 0), p(span, 0)]
    case "elbow": {
      const a = span * 0.3
      return [p(0, 0), p(a, 0), p(a + 56, 56), p(span, 56)]
    }
    case "dogleg": {
      const a = span * 0.24,
        b = span * 0.66
      return [
        p(0, 0),
        p(a, 0),
        p(a + 56, -56),
        p(b, -56),
        p(b + 56, 0),
        p(span, 0),
      ]
    }
    case "staircase": {
      const a = span * 0.22,
        b = span * 0.6
      return [
        p(0, 0),
        p(a, 0),
        p(a + 44, 44),
        p(b, 44),
        p(b + 44, 88),
        p(span, 88),
      ]
    }
    case "sweep": {
      const a = span * 0.2
      return [p(0, 0), p(a, 0), p(a + 72, -72), p(span, -72)]
    }
    case "offset": {
      const a = span * 0.42
      return [p(0, 0), p(a, 0), p(a, 72), p(span, 72)]
    }
  }
}

/** Every profile ends on its lowest point, so a row's extent is
 * [end - height, end]. */
function profileExtent(shape: RouteShape) {
  const ys = profile(shape, 1000).map((p) => p.y)
  const end = ys.at(-1)!
  return { end, height: end - Math.min(...ys) }
}

function stationDistances(
  track: Track,
  trackEnd: number,
  count: number
): number[] {
  if (count === 0) return []
  let runs = straightRuns(
    track,
    DEPOT_GAP,
    trackEnd - TRACK_TAIL,
    STATION_CLEARANCE
  )
  if (runs.length === 0) runs = [[0, trackEnd]]
  const total = runs.reduce((sum, [a, b]) => sum + b - a, 0)
  const at = (offset: number) => {
    for (const [a, b] of runs) {
      if (offset <= b - a + 1e-6) return a + offset
      offset -= b - a
    }
    return runs.at(-1)![1]
  }
  if (count === 1) return [at(total / 2)]
  return Array.from({ length: count }, (_, i) => at((total * i) / (count - 1)))
}

/** The shortest span whose straight track fits `count` evenly spaced
 * Stations, so labels never collide. */
function spanFor(shape: RouteShape, count: number): number {
  const needed = Math.max(1, (count - 1) * STATION_SPACING)
  for (let span = 260; ; span += 10) {
    const points = profile(shape, span)
    const end = points.at(-1)!
    const track = roundTrack(
      [...points, { x: end.x + 200, y: end.y }],
      () => CORNER_RADIUS
    )
    const runs = straightRuns(
      track,
      DEPOT_GAP,
      track.vertexDistance[points.length - 1]! - TRACK_TAIL,
      STATION_CLEARANCE
    )
    if (runs.reduce((sum, [a, b]) => sum + b - a, 0) >= needed) return span
  }
}

export interface RouteLayout {
  line: Line
  number: number
  color: string
  shape: RouteShape
  /** Left or right of Terminus; labels and bullets sit on the outer side. */
  side: "left" | "right"
  /** Control polyline: horizontal, vertical and 45° segments only. */
  points: Point[]
  stationTrack: Point[]
  track: Track
  trackEnd: number
  stations: Point[]
  stationDistances: number[]
  stopStationIds?: string[]
  depot: Point
}

/** Lines enter Terminus as a parallel bundle: each side's upper Lines curve
 * down into it and lower Lines curve up, on concentric curves, so no Line
 * crosses another and none needs a short jog. A middle row runs straight in.
 * Extra Stations widen the canvas; extra Lines make it taller. */
export function layoutNetwork(lines: Line[]) {
  if (lines.some((l) => l.stops?.some((s) => s.kind === "crossing")))
    return layoutCrossings(lines)
  let availableShapes: RouteShape[] = [...routeShapes]
  const shapes = lines.map((line) => {
    if (availableShapes.length === 0) availableShapes = [...routeShapes]
    const shape = shapeForLine(line.id, availableShapes)
    availableShapes = availableShapes.filter((candidate) => candidate !== shape)
    return shape
  })
  const span = Math.max(
    260,
    ...lines.map((line, i) => spanFor(shapes[i]!, line.stationIds.length))
  )
  const sides = [0, 1].map((side) =>
    lines.map((_, i) => i).filter((i) => i % 2 === side)
  )
  const perSide = Math.max(1, ...sides.map((s) => s.length))
  const lanes = Math.max(1, Math.floor(perSide / 2))
  const outerRadius = CORNER_RADIUS + (lanes - 1) * LANE_GAP
  const diagonal = Math.max(
    56,
    (2 * TAN_EIGHTH * outerRadius + 16) / Math.SQRT2
  )
  const trackEndX = MARGIN_X + span
  const innerSpine = trackEndX + CORNER_RADIUS + (lanes - 1) * LANE_GAP
  const hubX = innerSpine + diagonal + HUB_RADIUS + HUB_ENTRY
  const hubHalfHeight = Math.max(
    HUB_RADIUS,
    ((perSide - 1) / 2) * LANE_GAP + 24
  )

  /** Approach lane `k` (0 = innermost) for an upper Line entering at `port`,
   * relative to a Terminus centred at y = 0. */
  const lane = (k: number, port: number) => {
    const spine = innerSpine - k * LANE_GAP
    const offset =
      port - k * LANE_GAP - (innerSpine + diagonal) + k * LANE_GAP * Math.SQRT2
    const radius = CORNER_RADIUS + k * LANE_GAP
    return {
      spine,
      turn: offset + spine,
      join: port - offset,
      radius,
      drop: CORNER_RADIUS + TAN_EIGHTH * radius + 10,
    }
  }

  type Draft = { index: number; points: Point[]; radii: number[] }
  const drafts: Draft[] = []
  for (const [sideIndex, members] of sides.entries()) {
    const n = members.length
    const mid = (n - 1) / 2
    const port = (j: number) => (j - mid) * LANE_GAP
    const extent = members.map((i) => profileExtent(shapes[i]!))
    const ends: number[] = []
    if (n % 2 === 1) ends[mid] = 0
    for (let j = Math.ceil(mid) - 1; j >= 0; j--) {
      const geometry = lane(j, port(j))
      let end = geometry.turn - geometry.drop
      if (ends[j + 1] !== undefined)
        end = Math.min(
          end,
          ends[j + 1]! - extent[j + 1]!.height - ROW_CLEARANCE
        )
      ends[j] = end
    }
    for (let j = Math.floor(mid) + 1; j < n; j++) {
      const geometry = lane(n - 1 - j, port(n - 1 - j))
      let end = -geometry.turn + geometry.drop
      if (ends[j - 1] !== undefined)
        end = Math.max(end, ends[j - 1]! + extent[j]!.height + ROW_CLEARANCE)
      ends[j] = end
    }
    members.forEach((index, j) => {
      const shape = shapes[index]!
      const base = ends[j]! - extent[j]!.end
      const track = profile(shape, span).map((p) => ({
        x: MARGIN_X + p.x,
        y: base + p.y,
      }))
      const end = track.at(-1)!
      const radii = track.map(() => CORNER_RADIUS)
      let points: Point[]
      if (j === mid) {
        points = [...track, { x: hubX, y: 0 }]
        radii.push(0)
      } else {
        const upper = j < mid
        const k = upper ? j : n - 1 - j
        const geometry = lane(k, port(k))
        const flip = upper ? 1 : -1
        points = [
          ...track,
          { x: geometry.spine, y: end.y },
          { x: geometry.spine, y: geometry.turn * flip },
          { x: geometry.join, y: port(j) },
          { x: hubX, y: port(j) },
        ]
        radii.push(CORNER_RADIUS, geometry.radius, geometry.radius, 0)
      }
      if (sideIndex === 1)
        points = points.map((p) => ({ x: 2 * hubX - p.x, y: p.y }))
      drafts.push({ index, points, radii })
    })
  }

  // Fit the canvas to what is drawn, so a one-sided network has no empty half.
  let top = -hubHalfHeight,
    bottom = hubHalfHeight + 64,
    left = hubX - HUB_LABEL_HALF_WIDTH,
    right = hubX + HUB_LABEL_HALF_WIDTH
  for (const { index, points } of drafts) {
    const trackYs = points
      .slice(0, profile(shapes[index]!, span).length)
      .map((p) => p.y)
    top = Math.min(top, Math.min(...trackYs) - LABEL_ROOM)
    bottom = Math.max(bottom, Math.max(...trackYs) + TRAIN_ROOM)
    const reach = BULLET_OFFSET + BULLET_LABEL_HALF_WIDTH
    left = Math.min(left, points[0]!.x - reach)
    right = Math.max(right, points[0]!.x + reach)
  }
  const shiftX = PADDING - left
  const shiftY = PADDING - top
  const width = right - left + 2 * PADDING
  const height = bottom - top + 2 * PADDING
  const hub = { x: hubX + shiftX, y: shiftY }

  const routes: RouteLayout[] = drafts
    .sort((a, b) => a.index - b.index)
    .map(({ index, points: local, radii }) => {
      const line = lines[index]!
      const points = local.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }))
      const trackLength = profile(shapes[index]!, span).length
      const track = roundTrack(points, (i) => radii[i] ?? CORNER_RADIUS)
      const trackEnd = track.vertexDistance[trackLength - 1]!
      const distances = stationDistances(
        track,
        trackEnd,
        line.stationIds.length
      )
      return {
        line,
        number: index + 1,
        color: lineColor(line, index),
        shape: shapes[index]!,
        side: index % 2 === 0 ? "left" : "right",
        points,
        stationTrack: points.slice(0, trackLength),
        track,
        trackEnd,
        stationDistances: distances,
        stations: distances.map((d) => pointOnTrack(track, d)),
        depot: points[0]!,
      }
    })
  return { width, height, hub, hubHalfHeight, routes }
}

/** Seconds for a Train in transit to cover half the distance to where it
 * waits; each further 60 seconds halves what remains. */
const TRANSIT_HALF_LIFE = 60
/** How far short of the next Station a Train waits for the work. */
const WAIT_GAP = 44

/** What the map needs to place a Train: its state and when it began. */
export type TrainMotion = Pick<TrainView, "stateEnteredAt" | "previous"> & {
  state: TrainState
}

const secondsBetween = (from: string, to: number) =>
  Math.max(0, (to - Date.parse(from)) / 1000)

/** Track distances of the run toward a Station: where it starts, where a
 * Train waits for the work, and the Station itself. */
function leg(route: RouteLayout, toward: string) {
  const index = (route.stopStationIds ?? route.line.stationIds).indexOf(toward)
  const to = route.stationDistances[index] ?? 0
  const from = index > 0 ? route.stationDistances[index - 1]! : 0
  return { from, to, wait: Math.max((from + to) / 2, to - WAIT_GAP) }
}

function transitDistance(route: RouteLayout, toward: string, seconds: number) {
  const { from, wait } = leg(route, toward)
  return from + (wait - from) * (1 - 0.5 ** (seconds / TRANSIT_HALF_LIFE))
}

/** Where a Train is drawn while it is not moving. */
function restingDistance(state: TrainState, route: RouteLayout): number | null {
  const station = (id: string) =>
    route.stationDistances[
      (route.stopStationIds ?? route.line.stationIds).indexOf(id)
    ] ?? 0
  switch (state.status) {
    case "unloaded":
    case "siding":
      return null
    case "held":
      if (
        state.reasons.some((reason) => reason.kind === "awaiting_user_approval")
      )
        return null
      return restingDistance(state.resume, route)
    case "blocked":
      return restingDistance(state.resume, route)
    case "ready":
      return state.at.kind === "depot" ? 0 : station(state.at.stationId)
    case "docked":
    case "reviewing":
      return station(state.at)
    case "in_transit":
      return leg(route, state.toward).wait
    case "approaching":
      return leg(route, state.toward).to
    case "returning":
      // Past the last Station, on straight track short of the approach lanes.
      return route.trackEnd - TRACK_TAIL * 0.45
  }
}

/**
 * A Train's distance along its route at time `now`, or null when it is off the
 * track. Motion is presentation only and never claims progress the backend has
 * not reported: a Train in transit eases toward a point short of the next
 * Station and waits there, reaching the Station only once its work is ready
 * (`approaching`). A blocked Train stays where it was when it stopped. The
 * renderer eases the drawn Train toward this target, which produces the
 * arrival run however briefly `approaching` lasts.
 */
export function trainDistance(
  motion: TrainMotion,
  route: RouteLayout,
  now: number
): number | null {
  const { state, previous } = motion
  const seconds = secondsBetween(motion.stateEnteredAt, now)
  switch (state.status) {
    case "in_transit":
      return transitDistance(route, state.toward, seconds)
    case "blocked":
      return previous && previous.state.status !== "blocked"
        ? trainDistance(
            {
              state: previous.state,
              stateEnteredAt: previous.enteredAt,
              previous: null,
            },
            route,
            Date.parse(motion.stateEnteredAt)
          )
        : restingDistance(state, route)
    default:
      return restingDistance(state, route)
  }
}

/** True while a Train's target position changes over time. */
export function isMoving(motion: TrainMotion): boolean {
  return motion.state.status === "in_transit"
}

/** Shared Station vertices provide deterministic topology; positions never decide movement. */
function layoutCrossings(lines: Line[]) {
  const stops = (line: Line) =>
    line.stops ??
    line.stationIds.map((stationId) => ({
      kind: "station" as const,
      stationId,
    }))
  const predecessors = new Map<string, Set<string>>()
  const owners = new Map<string, number>()
  for (const [row, line] of lines.entries()) {
    let previous = `depot:${line.id}`
    for (const stop of stops(line)) {
      if (stop.kind === "station") owners.set(stop.stationId, row)
      const before = predecessors.get(stop.stationId) ?? new Set<string>()
      before.add(previous)
      predecessors.set(stop.stationId, before)
      previous = stop.stationId
    }
  }
  const ranks = new Map<string, number>(),
    visiting = new Set<string>()
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!
    if (visiting.has(id)) return 1 // Invalid topology is rejected by the backend.
    visiting.add(id)
    const value = Math.max(
      0,
      ...[...(predecessors.get(id) ?? [])].map((p) => rank(p) + 1)
    )
    visiting.delete(id)
    ranks.set(id, value)
    return value
  }
  for (const id of predecessors.keys()) rank(id)
  const maxRank = Math.max(1, ...ranks.values())
  const hub = {
    x: MARGIN_X + (maxRank + 1) * STATION_SPACING,
    y: LABEL_ROOM + (Math.max(0, lines.length - 1) * ROW_CLEARANCE) / 2,
  }
  const rowY = (row: number) => LABEL_ROOM + row * ROW_CLEARANCE
  const routes: RouteLayout[] = lines.map((line, index) => {
    const ids = stops(line).map((s) => s.stationId)
    const depot = { x: MARGIN_X - STATION_SPACING / 2, y: rowY(index) }
    const stations = ids.map((id) => ({
      x: MARGIN_X + (ranks.get(id) ?? 1) * STATION_SPACING,
      y: rowY(owners.get(id) ?? index),
    }))
    const points: Point[] = [depot]
    const stationVertices: number[] = []
    for (const target of stations) {
      const prev = points.at(-1)!
      if (prev.y !== target.y)
        points.push(
          { x: (prev.x + target.x) / 2, y: prev.y },
          { x: (prev.x + target.x) / 2, y: target.y }
        )
      points.push(target)
      stationVertices.push(points.length - 1)
    }
    const end = points.at(-1)!
    points.push(
      { x: hub.x - STATION_SPACING / 2, y: end.y },
      { x: hub.x - STATION_SPACING / 2, y: hub.y },
      { x: hub.x, y: hub.y }
    )
    const track = roundTrack(points, (i) =>
      stationVertices.includes(i) ? 0 : CORNER_RADIUS
    )
    const distances = stationVertices.map((v) => track.vertexDistance[v] ?? 0)
    return {
      line,
      number: index + 1,
      color: lineColor(line, index),
      shape: "direct",
      side: "left",
      points,
      stationTrack: stations,
      track,
      trackEnd: track.length,
      stations,
      stationDistances: distances,
      stopStationIds: ids,
      depot,
    }
  })
  return {
    width: hub.x + HUB_LABEL_HALF_WIDTH + PADDING,
    height: rowY(Math.max(0, lines.length - 1)) + TRAIN_ROOM + PADDING,
    hub,
    hubHalfHeight: HUB_RADIUS,
    routes,
  }
}
