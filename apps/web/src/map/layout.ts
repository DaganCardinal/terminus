import type { Line, TrainState } from "@terminus/protocol"

export type Point = { x: number; y: number }
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
export function lineColor(line: Line, index: number): string {
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

export interface RouteLayout {
  line: Line
  number: number
  color: string
  shape: RouteShape
  points: Point[]
  stationTrack: Point[]
  stations: Point[]
  depot: Point
}

export function pointAlong(points: Point[], fraction: number): Point {
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  let distance =
    Math.max(0, Math.min(1, fraction)) * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (distance <= length && length > 0) {
      const a = points[i]!,
        b = points[i + 1]!
      return {
        x: a.x + ((b.x - a.x) * distance) / length,
        y: a.y + ((b.y - a.y) * distance) / length,
      }
    }
    distance -= length
  }
  return points.at(-1) ?? { x: 0, y: 0 }
}

/** All bends are horizontal, vertical or 45 degrees. Routes occupy separate
 * corridors and meet only at Terminus. Extra stations grow the canvas. */
export function layoutNetwork(lines: Line[]) {
  const rows = Math.max(2, Math.ceil(lines.length / 2))
  const halfWidth = Math.max(
    620,
    240 + Math.max(0, ...lines.map((l) => l.stationIds.length)) * 170
  )
  const width = halfWidth * 2
  const height = rows * 280 + 160
  const hub = { x: halfWidth, y: height / 2 }
  let availableShapes: RouteShape[] = [...routeShapes]
  const routes: RouteLayout[] = lines.map((line, index) => {
    const side = index % 2 === 0 ? 1 : -1
    const row = Math.floor(index / 2)
    const y = 160 + row * 280
    if (availableShapes.length === 0) availableShapes = [...routeShapes]
    const shape = shapeForLine(line.id, availableShapes)
    availableShapes = availableShapes.filter((candidate) => candidate !== shape)
    const bend = {
      direct: 0,
      elbow: 52,
      dogleg: -52,
      staircase: 40,
      sweep: -70,
      offset: 64,
    }[shape]
    const span = halfWidth - 280
    const raw: Point[] = [{ x: 0, y: 0 }]
    if (shape === "direct") raw.push({ x: span, y: 0 })
    if (shape === "elbow")
      raw.push(
        { x: span * 0.3, y: 0 },
        { x: span * 0.3 + 52, y: bend },
        { x: span, y: bend }
      )
    if (shape === "dogleg")
      raw.push(
        { x: span * 0.25, y: 0 },
        { x: span * 0.25 + 52, y: bend },
        { x: span * 0.7, y: bend },
        { x: span * 0.7 + 52, y: 0 },
        { x: span, y: 0 }
      )
    if (shape === "staircase")
      raw.push(
        { x: span * 0.2, y: 0 },
        { x: span * 0.2 + 40, y: 40 },
        { x: span * 0.6, y: 40 },
        { x: span * 0.6 + 40, y: 80 },
        { x: span, y: 80 }
      )
    if (shape === "sweep")
      raw.push(
        { x: span * 0.2, y: 0 },
        { x: span * 0.2 + 70, y: bend },
        { x: span, y: bend }
      )
    if (shape === "offset")
      raw.push(
        { x: span * 0.4, y: 0 },
        { x: span * 0.4, y: bend },
        { x: span, y: bend }
      )
    const map = (p: Point) => ({
      x: side === 1 ? 100 + p.x : width - 100 - p.x,
      y: y + p.y,
    })
    const track = raw.map(map)
    const end = track.at(-1)!
    // Separate approach lanes reach distinct ports on the Terminus ring.
    // Crossings have no Station marker and never imply a domain connection.
    const portY = hub.y + (rows === 1 ? 0 : (row / (rows - 1) - 0.5) * 56)
    const spineX = end.x + side * (row % 6) * 18
    const diagonal = Math.min(90, Math.abs(end.y - portY))
    const approachY = portY + Math.sign(end.y - portY) * diagonal
    const points = [
      ...track,
      { x: spineX, y: end.y },
      { x: spineX, y: approachY },
      { x: spineX + side * diagonal, y: portY },
      { x: hub.x, y: portY },
    ]
    return {
      line,
      number: index + 1,
      color: lineColor(line, index),
      shape,
      points,
      stationTrack: track,
      depot: track[0]!,
      stations: line.stationIds.map((_, i) =>
        pointAlong(track, (i + 0.65) / (line.stationIds.length + 0.25))
      ),
    }
  })
  return { width, height, hub, routes }
}

/** Positions represent lifecycle phases, never time elapsed or % complete. */
export function trainPoint(
  state: TrainState,
  route: RouteLayout,
  hub: Point
): Point | null {
  const station = (id: string) =>
    route.stations[route.line.stationIds.indexOf(id)] ?? route.depot
  switch (state.status) {
    case "unloaded":
    case "siding":
      return null
    case "held":
    case "blocked":
      return trainPoint(state.resume, route, hub)
    case "ready":
      return state.at.kind === "depot"
        ? route.depot
        : station(state.at.stationId)
    case "docked":
    case "reviewing":
      return station(state.at)
    case "in_transit":
    case "approaching": {
      const index = route.line.stationIds.indexOf(state.toward)
      const offset = state.status === "approaching" ? 0.5 : 0.2
      return pointAlong(
        route.stationTrack,
        (index + offset) / (route.line.stationIds.length + 0.25)
      )
    }
    case "returning":
      return pointAlong(route.points.slice(-3), 0.65)
  }
}
