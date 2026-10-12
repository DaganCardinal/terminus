import {
  lineIdentities,
  type Line,
  type LineIdentity,
  type EventEnvelope,
  type NetworkSnapshot,
  type TrainState,
  type TrainView,
} from "@terminus/protocol"
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
/** A Line's route colour, from the palette index in its identity. */
export function lineColor(color: number): string {
  return colors[color % colors.length]!
}

/** Every Line's identity when all of them are live, in order. */
function freshIdentities(lines: Line[]) {
  return lineIdentities({ network: { createdAt: "" }, lines, trains: [] })
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
  /** Where the route bullet sits, when it is not just outside the depot. */
  bullet?: Point
}

/** A Junction marker, sized to the approach lanes that enter it. */
export interface JunctionLayout {
  id: string
  point: Point
  halfHeight: number
}

/** A Station that receiving Lines visit through a Crossing. Each receiver
 * passes through on its own lane beside the source track, so the Lines meet
 * only at the Station and diverge right after it. */
export interface Interchange {
  stationId: string
  at: Point
  /** `remote` marks a pickup whose route order cannot pass the Station
   * itself; it sits on the receiver's own row, linked to the Station. */
  lanes: { lineId: string; crossingId: string; point: Point; remote?: true }[]
}

export interface NetworkLayout {
  width: number
  height: number
  hub: Point
  hubHalfHeight: number
  routes: RouteLayout[]
  junctions: JunctionLayout[]
  interchanges: Interchange[]
}

/** Lines enter Terminus as a parallel bundle: each side's upper Lines curve
 * down into it and lower Lines curve up, on concentric curves, so no Line
 * crosses another and none needs a short jog. A middle row runs straight in.
 * Extra Stations widen the canvas; extra Lines make it taller.
 *
 * Each Line's number, colour and shape come from its identity. Its row comes
 * from its identity's slot, so a new Line takes a finished Line's place, or,
 * with `placement: "order"`, from its position in `lines`. */
export function layoutNetwork(
  lines: Line[],
  identities?: Map<string, LineIdentity>,
  placement: "slot" | "order" = "slot"
): NetworkLayout {
  let fresh: Map<string, LineIdentity> | undefined
  const identity = (line: Line) =>
    identities?.get(line.id) ?? (fresh ??= freshIdentities(lines)).get(line.id)!
  const placed =
    placement === "slot"
      ? [...lines].sort((a, b) => identity(a).slot - identity(b).slot)
      : lines
  const keys = placed.map((line, i) =>
    placement === "slot" ? identity(line).slot : i
  )
  if (
    placed.some(
      (l) =>
        l.destination?.kind === "junction" ||
        l.origin?.kind === "junction" ||
        l.stops?.some((s) => s.kind === "crossing")
    )
  )
    return layoutGraph(placed, identity)
  return layoutBundle(placed, identity, keys)
}

function layoutBundle(
  lines: Line[],
  identity: (line: Line) => LineIdentity,
  keys: number[]
): NetworkLayout {
  const shapes = lines.map((line) => routeShapes[identity(line).shape]!)
  const span = Math.max(
    260,
    ...lines.map((line, i) => spanFor(shapes[i]!, line.stationIds.length))
  )
  const sides = [0, 1].map((side) =>
    lines.map((_, i) => i).filter((i) => keys[i]! % 2 === side)
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
        number: identity(line).slot + 1,
        color: lineColor(identity(line).color),
        shape: shapes[index]!,
        side: keys[index]! % 2 === 0 ? "left" : "right",
        points,
        stationTrack: points.slice(0, trackLength),
        track,
        trackEnd,
        stationDistances: distances,
        stations: distances.map((d) => pointOnTrack(track, d)),
        depot: points[0]!,
      }
    })
  return {
    width,
    height,
    hub,
    hubHalfHeight,
    routes,
    junctions: [],
    interchanges: [],
  }
}

// Graph layout: Crossings and Junctions. Columns come from route order, rows
// from Lines. Each Line keeps to its own row and leaves it only to visit a
// Crossing Station or to take its own lane into a Junction or Terminus.
const JUNCTION_HALF = 28
/** Approach lanes turn this far before a node, clear of its label. */
const JUNCTION_CLEAR = 80
const HUB_CLEAR = 104
/** Room after a Junction for the outgoing Line's bullet and name. */
const JUNCTION_EXIT = 140
const OUTGOING_BULLET = 150
/** Straight track a Line needs between its last stop and its approach lane. */
const APPROACH_ROOM = 150
/** How far before a Crossing Station a receiver leaves its row. The wider
 * offset keeps a vertical clear of the Station labels it passes. */
const VISIT_OFFSET = 50
const VISIT_OFFSET_WIDE = 80
const STATION_LABEL_TOP = 100

type Fan = {
  y: number
  half: number
  /** Port offset; approach lane (-1 = straight in), counted from the lane
   * that turns closest to the node; and concentric curve index. */
  feeds: Map<number, { port: number; lane: number; curve: number }>
  lanes: number
}

/** Ports on a node in row order, so approach lanes never cross. Lines above
 * curve down into it and Lines below curve up, on concentric curves; the
 * lower group turns further out, so the two never share a vertical. The node
 * sits level with `center`, or with the feeder nearest the middle. */
function fanIn(feeders: { index: number; y: number }[], center?: number): Fan {
  const sorted = [...feeders].sort((a, b) => a.y - b.y || a.index - b.index)
  const mean = sorted.reduce((sum, f) => sum + f.y, 0) / (sorted.length || 1)
  const found = sorted.findIndex((f) => f.index === center)
  const mid =
    found >= 0
      ? found
      : sorted.reduce(
          (best, f, i) =>
            Math.abs(f.y - mean) < Math.abs(sorted[best]!.y - mean) ? i : best,
          0
        )
  const below = sorted.length - 1 - mid
  const feeds = new Map(
    sorted.map((f, i) => [
      f.index,
      {
        port: (i - mid) * LANE_GAP,
        lane: i < mid ? i : i > mid ? mid + sorted.length - 1 - i : -1,
        curve: i < mid ? i : sorted.length - 1 - i,
      },
    ])
  )
  return {
    y: sorted[mid]?.y ?? 0,
    half: Math.max(mid, below) * LANE_GAP,
    feeds,
    lanes: Math.max(0, sorted.length - 1),
  }
}

function layoutGraph(
  lines: Line[],
  identity: (line: Line) => LineIdentity
): NetworkLayout {
  const stopsOf = (line: Line) =>
    line.stops ??
    line.stationIds.map((stationId) => ({
      kind: "station" as const,
      stationId,
    }))
  const into = (l: Line) =>
    l.destination?.kind === "junction" ? l.destination.junctionId : undefined
  const outOf = (l: Line) =>
    l.origin?.kind === "junction" ? l.origin.junctionId : undefined
  const owner = new Map<string, number>()
  lines.forEach((l, i) => l.stationIds.forEach((id) => owner.set(id, i)))
  const foreign = (i: number, stop: ReturnType<typeof stopsOf>[number]) =>
    stop.kind === "crossing" &&
    owner.has(stop.stationId) &&
    owner.get(stop.stationId) !== i
  const startOf = (l: Line) =>
    outOf(l) ? `junction:${outOf(l)}` : `depot:${l.id}`
  const endOf = (l: Line) => (into(l) ? `junction:${into(l)}` : "terminus")

  // Columns: the longest route to each stop, so every route runs left to
  // right. Each Line's own stops come first. A Crossing visit whose order
  // contradicts another route's (one receiver visits A then B, another B then
  // A) cannot share the source Station's column, so it becomes a remote
  // pickup on the receiver's own row instead.
  const successors = new Map<string, Set<string>>()
  const link = (from: string, to: string) =>
    successors.set(from, (successors.get(from) ?? new Set()).add(to))
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>()
    const walk = (id: string): boolean =>
      id === to ||
      (!seen.has(id) &&
        (seen.add(id), [...(successors.get(id) ?? [])].some(walk)))
    return walk(from)
  }
  lines.forEach((l, i) => {
    let previous = startOf(l)
    for (const stop of stopsOf(l))
      if (!foreign(i, stop)) {
        link(previous, stop.stationId)
        previous = stop.stationId
      }
    link(previous, endOf(l))
  })
  const remote = new Set<string>()
  const nodeOf = (i: number, stop: ReturnType<typeof stopsOf>[number]) =>
    stop.kind === "crossing" && remote.has(`${i}|${stop.crossingId}`)
      ? `visit:${i}|${stop.crossingId}`
      : stop.stationId
  lines.forEach((l, i) => {
    const stops = stopsOf(l)
    let previous = startOf(l)
    stops.forEach((stop, k) => {
      if (!foreign(i, stop) || stop.kind !== "crossing") {
        previous = stop.stationId
        return
      }
      const next =
        stops.slice(k + 1).find((s) => !foreign(i, s))?.stationId ?? endOf(l)
      if (reaches(stop.stationId, previous) || reaches(next, stop.stationId))
        remote.add(`${i}|${stop.crossingId}`)
      const node = nodeOf(i, stop)
      link(previous, node)
      link(node, next)
      previous = node
    })
  })
  const visits = (i: number) =>
    stopsOf(lines[i]!).flatMap((stop) =>
      stop.kind === "crossing" &&
      foreign(i, stop) &&
      !remote.has(`${i}|${stop.crossingId}`)
        ? [{ stationId: stop.stationId, crossingId: stop.crossingId }]
        : []
    )
  const predecessors = new Map<string, string[]>()
  for (const [from, tos] of successors)
    for (const to of tos)
      predecessors.set(to, [...(predecessors.get(to) ?? []), from])
  const ranks = new Map<string, number>()
  const rank = (id: string): number => {
    if (!ranks.has(id))
      ranks.set(
        id,
        Math.max(0, ...(predecessors.get(id) ?? []).map((p) => rank(p) + 1))
      )
    return ranks.get(id)!
  }

  // Rows: a Junction's incoming Lines sit together, the middle one as its
  // trunk; the outgoing Line continues on the trunk row. Rows are then
  // reordered to keep Crossing receivers near their sources.
  const members = new Map<string, number[]>()
  lines.forEach((l, i) => {
    const id = into(l)
    if (id) members.set(id, [...(members.get(id) ?? []), i])
  })
  const blocks: number[][] = []
  lines.forEach((l, i) => {
    const id = into(l)
    if (id) {
      if (members.get(id)![0] === i) blocks.push(members.get(id)!)
    } else if (!(outOf(l) && members.has(outOf(l)!))) blocks.push([i])
  })
  const trunkIn = (order: number[][], id: string) => {
    const block = order.find((b) => into(lines[b[0]!]!) === id) ?? []
    return block[Math.floor((block.length - 1) / 2)]
  }
  const rowsFor = (order: number[][]) => {
    const row = new Map(order.flat().map((i, r) => [i, r] as const))
    lines.forEach((l, i) => {
      if (!row.has(i)) row.set(i, row.get(trunkIn(order, outOf(l)!)!)!)
    })
    return row
  }
  const cost = (order: number[][]) => {
    const row = rowsFor(order)
    let total = 0
    lines.forEach((_, i) => {
      for (const v of visits(i))
        total += Math.abs(row.get(i)! - row.get(owner.get(v.stationId)!)!)
    })
    return total
  }
  // Swap neighbouring blocks, and neighbouring Lines within a Junction block,
  // while that brings receivers closer to their sources.
  const swaps = (order: number[][]) => [
    ...order.slice(1).map((_, b) => {
      const next = [...order]
      ;[next[b], next[b + 1]] = [next[b + 1]!, next[b]!]
      return next
    }),
    ...order.flatMap((block, b) =>
      block.slice(1).map((_, m) => {
        const swapped = [...block]
        ;[swapped[m], swapped[m + 1]] = [swapped[m + 1]!, swapped[m]!]
        return order.map((other, c) => (c === b ? swapped : other))
      })
    ),
  ]
  let order = blocks
  for (let improved = true; improved;) {
    improved = false
    for (const next of swaps(order))
      if (cost(next) < cost(order)) {
        order = next
        improved = true
      }
  }
  const row = rowsFor(order)
  const trunk = (id: string) => trunkIn(order, id)
  const homeY = (i: number) => row.get(i)! * ROW_CLEARANCE

  // Approach lanes into each Junction and into Terminus.
  const junctionIds = [
    ...new Set(lines.flatMap((l) => [into(l), outOf(l)].filter((id) => id))),
  ] as string[]
  const fans = new Map<string, Fan>()
  for (const id of junctionIds) {
    const incoming = members.get(id) ?? []
    const outgoing = lines.findIndex((l) => outOf(l) === id)
    fans.set(
      `junction:${id}`,
      incoming.length
        ? fanIn(
            incoming.map((i) => ({ index: i, y: homeY(i) })),
            trunk(id)
          )
        : fanIn([{ index: outgoing, y: homeY(outgoing) }])
    )
  }
  const hubFeeds = lines.flatMap((l, i) =>
    into(l) ? [] : [{ index: i, y: homeY(i) }]
  )
  fans.set("terminus", fanIn(hubFeeds))

  // Receivers pass a Crossing Station on lanes beside the source track: the
  // closest receiver on the inside, each turning on concentric curves.
  // Visits in one column whose verticals would share height step further out.
  type Visit = { y: number; offset: number; radius: number }
  type Group = {
    stationId: string
    column: number
    y: number
    side: number
    receivers: { r: number; crossingId: string; from: number }[]
    top: number
    bottom: number
    offset: number
  }
  const groups: Group[] = []
  for (const [stationId, i] of owner) {
    const y = homeY(i)
    const receivers = lines.flatMap((_, r) =>
      visits(r)
        .filter((v) => v.stationId === stationId)
        .map((v) => ({ r, crossingId: v.crossingId, from: homeY(r) - y }))
    )
    for (const side of [-1, 1]) {
      const group = receivers
        .filter((v) => (v.from > 0 ? 1 : -1) === side)
        .sort((a, b) => Math.abs(a.from) - Math.abs(b.from) || a.r - b.r)
      if (group.length === 0) continue
      const ends = group.map((v) => y + v.from)
      groups.push({
        stationId,
        column: rank(stationId),
        y,
        side,
        receivers: group,
        top: Math.min(y, ...ends),
        bottom: Math.max(y, ...ends),
        offset: group.some((v) => side < 0 || Math.abs(v.from) > ROW_CLEARANCE)
          ? VISIT_OFFSET_WIDE
          : VISIT_OFFSET,
      })
    }
  }
  groups.sort(
    (a, b) => a.column - b.column || a.bottom - a.top - (b.bottom - b.top)
  )
  const span = (g: Group) => g.offset + (g.receivers.length - 1) * LANE_GAP
  groups.forEach((g, k) => {
    for (let moved = true; moved;) {
      moved = false
      for (const other of groups.slice(0, k))
        if (
          other.column === g.column &&
          other.top < g.bottom &&
          g.top < other.bottom &&
          g.offset <= span(other) + LANE_GAP &&
          other.offset <= span(g) + LANE_GAP
        ) {
          g.offset = span(other) + 2 * LANE_GAP
          moved = true
        }
    }
  })

  // Column positions, widened where approach lanes, visits and outgoing
  // bullets need room.
  const columns = Math.max(0, ...[...predecessors.keys()].map(rank)) + 1
  const gaps = Array.from({ length: columns }, () => STATION_SPACING)
  for (const [node, fan] of fans) {
    const c = rank(node)
    const clear = node === "terminus" ? HUB_CLEAR : JUNCTION_CLEAR
    if (c > 0)
      gaps[c - 1] = Math.max(
        gaps[c - 1]!,
        clear + fan.lanes * LANE_GAP + APPROACH_ROOM
      )
    if (node !== "terminus" && c + 1 < columns)
      gaps[c] = gaps[c]! + JUNCTION_EXIT
  }
  for (const g of groups) {
    const room = span(g) + CORNER_RADIUS + STATION_CLEARANCE + 10
    if (g.column > 0) gaps[g.column - 1] = Math.max(gaps[g.column - 1]!, room)
    if (g.column + 1 < columns) gaps[g.column] = Math.max(gaps[g.column]!, room)
  }
  const columnX = [0]
  for (let c = 1; c < columns; c++) columnX.push(columnX[c - 1]! + gaps[c - 1]!)
  const nodePoint = (node: string) => ({
    x: columnX[rank(node)]!,
    y: fans.get(node)!.y,
  })

  const lanes = new Map<string, Visit>()
  const interchanges: Interchange[] = []
  for (const g of groups) {
    const x = columnX[g.column]!
    let interchange = interchanges.find((c) => c.stationId === g.stationId)
    if (!interchange) {
      interchange = { stationId: g.stationId, at: { x, y: g.y }, lanes: [] }
      interchanges.push(interchange)
    }
    g.receivers.forEach((v, k) => {
      const outer = g.receivers.length - 1 - k
      const visit = {
        y: g.y + g.side * (k + 1) * LANE_GAP,
        offset: g.offset + outer * LANE_GAP,
        radius: CORNER_RADIUS + outer * LANE_GAP,
      }
      lanes.set(`${v.r}|${g.stationId}`, visit)
      interchange.lanes.push({
        lineId: lines[v.r]!.id,
        crossingId: v.crossingId,
        point: { x, y: visit.y },
      })
    })
  }

  lines.forEach((l, i) => {
    for (const stop of stopsOf(l)) {
      if (stop.kind !== "crossing" || !remote.has(`${i}|${stop.crossingId}`))
        continue
      const source = owner.get(stop.stationId)!
      let interchange = interchanges.find((c) => c.stationId === stop.stationId)
      if (!interchange) {
        interchange = {
          stationId: stop.stationId,
          at: { x: columnX[rank(stop.stationId)]!, y: homeY(source) },
          lanes: [],
        }
        interchanges.push(interchange)
      }
      interchange.lanes.push({
        lineId: l.id,
        crossingId: stop.crossingId,
        point: { x: columnX[rank(nodeOf(i, stop))]!, y: homeY(i) },
        remote: true,
      })
    }
  })

  type Draft = {
    points: Point[]
    radii: number[]
    stationVertices: number[]
    approach: number | null
    bullet: Point
  }
  const drafts: Draft[] = lines.map((line, index) => {
    const home = homeY(index)
    const origin = outOf(line)
    const start = origin
      ? nodePoint(`junction:${origin}`)
      : { x: columnX[0]!, y: home }
    const points: Point[] = [start],
      radii: number[] = [0],
      stationVertices: number[] = []
    const push = (p: Point, radius = CORNER_RADIUS) => {
      points.push(p)
      radii.push(radius)
    }
    let at: (Visit & { x: number; stationId: string }) | null = null
    // A receiver stays beside the source only between neighbouring Stations.
    const neighbours = (a: string, b: string) => {
      const ids = lines[owner.get(a)!]!.stationIds
      return (
        owner.get(a) === owner.get(b) &&
        Math.abs(ids.indexOf(a) - ids.indexOf(b)) === 1
      )
    }
    const goHome = () => {
      if (!at) return
      push({ x: at.x + at.offset, y: at.y }, at.radius)
      push({ x: at.x + at.offset, y: home })
      at = null
    }
    for (const stop of stopsOf(line)) {
      const x = columnX[rank(nodeOf(index, stop))]!
      const visit = lanes.get(`${index}|${stop.stationId}`)
      if (!visit) {
        goHome()
        push({ x, y: home }, 0)
      } else {
        const cramped =
          at !== null &&
          x - visit.offset - (at.x + at.offset) < 2 * CORNER_RADIUS + 8
        if (
          at?.y === visit.y &&
          (cramped || neighbours(at.stationId, stop.stationId))
        ) {
          // Neighbouring Stations on the same lane: stay on it.
        } else if (at && cramped) {
          const mid = (at.x + x) / 2
          push({ x: mid, y: at.y })
          push({ x: mid, y: visit.y })
        } else {
          goHome()
          push({ x: x - visit.offset, y: home })
          push({ x: x - visit.offset, y: visit.y }, visit.radius)
        }
        push({ x, y: visit.y }, 0)
        at = { ...visit, x, stationId: stop.stationId }
      }
      stationVertices.push(points.length - 1)
    }
    goHome()
    const node = into(line) ? `junction:${into(line)}` : "terminus"
    const fan = fans.get(node)!
    const target = nodePoint(node)
    const feed = fan.feeds.get(index) ?? { port: 0, lane: -1, curve: 0 }
    const end = { x: target.x, y: target.y + feed.port }
    const clear = node === "terminus" ? HUB_CLEAR : JUNCTION_CLEAR
    const turn = target.x - clear - Math.max(0, feed.lane) * LANE_GAP
    let approach: number | null = null
    const marker = feed.lane < 0 ? target.x - clear : turn - CORNER_RADIUS - 2
    if (marker > points.at(-1)!.x + 1) {
      push({ x: marker, y: home }, 0)
      approach = points.length - 1
    }
    if (feed.lane >= 0) {
      push({ x: turn, y: home })
      push({ x: turn, y: end.y }, CORNER_RADIUS + feed.curve * LANE_GAP)
    }
    push(end, 0)
    const bullet = origin
      ? { x: start.x + OUTGOING_BULLET, y: start.y }
      : { x: start.x - BULLET_OFFSET, y: start.y }
    return { points, radii, stationVertices, approach, bullet }
  })

  // Fit the canvas to what is drawn, labels included.
  const hub = nodePoint("terminus")
  const hubHalfHeight = Math.max(HUB_RADIUS, fans.get("terminus")!.half + 24)
  const junctions: JunctionLayout[] = junctionIds.map((id) => ({
    id,
    point: nodePoint(`junction:${id}`),
    halfHeight: Math.max(JUNCTION_HALF, fans.get(`junction:${id}`)!.half + 20),
  }))
  let left = hub.x - HUB_LABEL_HALF_WIDTH,
    right = hub.x + HUB_LABEL_HALF_WIDTH,
    top = hub.y - hubHalfHeight,
    bottom = hub.y + hubHalfHeight + 64
  const include = (x0: number, x1: number, y0: number, y1: number) => {
    left = Math.min(left, x0)
    right = Math.max(right, x1)
    top = Math.min(top, y0)
    bottom = Math.max(bottom, y1)
  }
  for (const d of drafts) {
    const reach = BULLET_LABEL_HALF_WIDTH
    include(d.bullet.x - reach, d.bullet.x + reach, d.bullet.y - 70, d.bullet.y)
    for (const p of d.points) include(p.x, p.x, p.y, p.y + TRAIN_ROOM - 20)
    for (const v of d.stationVertices) {
      const p = d.points[v]!
      include(p.x - 80, p.x + 80, p.y - STATION_LABEL_TOP - 2 * LANE_GAP, p.y)
    }
  }
  for (const j of junctions)
    include(
      j.point.x - 80,
      j.point.x + 80,
      j.point.y - j.halfHeight - 56,
      j.point.y + j.halfHeight + TRAIN_ROOM - 20
    )
  const dx = PADDING - left,
    dy = PADDING - top
  const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy })

  const routes: RouteLayout[] = lines.map((line, index) => {
    const d = drafts[index]!
    const points = d.points.map(shift)
    const track = roundTrack(points, (i) => d.radii[i] ?? CORNER_RADIUS)
    const distances = d.stationVertices.map((v) => track.vertexDistance[v]!)
    const last = distances.at(-1) ?? 0
    const approach =
      d.approach === null ? last : track.vertexDistance[d.approach]!
    const stations = d.stationVertices.map((v) => points[v]!)
    return {
      line,
      number: identity(line).slot + 1,
      color: lineColor(identity(line).color),
      shape: "direct",
      side: "left",
      points,
      stationTrack: stations,
      track,
      // Halfway between the last stop and the approach lanes.
      trackEnd: (last + approach) / 2 + TRACK_TAIL * 0.45,
      stations,
      stationDistances: distances,
      stopStationIds: stopsOf(line).map((s) => s.stationId),
      depot: points[0]!,
      bullet: shift(d.bullet),
    }
  })
  return {
    width: right - left + 2 * PADDING,
    height: bottom - top + 2 * PADDING,
    hub: shift(hub),
    hubHalfHeight,
    routes,
    junctions: junctions.map((j) => ({ ...j, point: shift(j.point) })),
    interchanges: interchanges.map((c) => ({
      ...c,
      at: shift(c.at),
      lanes: c.lanes.map((l) => ({ ...l, point: shift(l.point) })),
    })),
  }
}

/** Seconds for a Train in transit to cover half the distance to where it
 * waits; each further 60 seconds halves what remains. */
const TRANSIT_HALF_LIFE = 60
/** How far short of the next Station a Train waits for the work. */
const WAIT_GAP = 44

/** What the map needs to place a Train: its state and when it began. */
export type TrainMotion = Pick<TrainView, "stateEnteredAt" | "previous"> & {
  state: TrainState
  /** Where the Train stopped when it was blocked, while that block is
   * unresolved (see `trainStops`). */
  stop?: TrainStop | null
}

/** The run a Train was on when it was blocked, and when it stopped. */
export type TrainStop = { motion: TrainMotion; at: number }

const secondsBetween = (from: string, to: number) =>
  Math.max(0, (to - Date.parse(from)) / 1000)

/** Track distances of the run toward a Station, or toward Terminus (or the
 * Junction) when `toward` is null: where it starts, where a Train waits for
 * the work, and the destination itself. */
export function leg(route: RouteLayout, toward: string | null) {
  const stops = route.stopStationIds ?? route.line.stationIds
  const index = toward === null ? stops.length : stops.indexOf(toward)
  const to =
    toward === null ? route.track.length : (route.stationDistances[index] ?? 0)
  const from = index > 0 ? route.stationDistances[index - 1]! : 0
  // Terminus is drawn around the track's end, so Trains wait outside it.
  const gap = toward === null ? HUB_RADIUS + WAIT_GAP : WAIT_GAP
  return { from, to, wait: Math.max((from + to) / 2, to - gap) }
}

function transitDistance(
  { from, wait }: ReturnType<typeof leg>,
  seconds: number
) {
  return from + (wait - from) * (1 - 0.5 ** (seconds / TRANSIT_HALF_LIFE))
}

/** States in which a Train stays where an unresolved block stopped it. */
const stopped = ({ state, stop }: TrainMotion) =>
  !!stop &&
  ["ready", "in_transit", "returning", "held", "blocked"].includes(state.status)

/** True while a cleared Train works on what it was blocked doing. */
export const clearingBlock = (motion: TrainMotion) =>
  stopped(motion) &&
  ["ready", "in_transit", "returning"].includes(motion.state.status)

/**
 * Where each Train stopped when it was last blocked, while that block is
 * unresolved, replayed from the event log. In the domain, clearing a block
 * sends a Train back to its last stop to run the Station again; the map
 * leaves it where it stopped until that run's work is ready, it reaches
 * Terminus, or it moves on to a different Station.
 */
export function trainStops(events: EventEnvelope[]): Map<string, TrainStop> {
  const runs = new Map<string, TrainMotion>()
  const stops = new Map<string, TrainStop & { toward: string | null }>()
  const run = (state: TrainState, at: string): TrainMotion => ({
    state,
    stateEnteredAt: at,
    previous: null,
  })
  for (const { event, occurredAt } of events) {
    switch (event.type) {
      case "train.departed":
        // Departing again toward the stopped Station re-runs its work.
        if (stops.get(event.trainId)?.toward === event.stationId) break
        stops.delete(event.trainId)
        runs.set(
          event.trainId,
          run(
            {
              status: "in_transit",
              from: { kind: "depot" },
              toward: event.stationId,
            },
            occurredAt
          )
        )
        break
      case "train.returning":
        if (stops.get(event.trainId)?.toward === null) break
        stops.delete(event.trainId)
        runs.set(
          event.trainId,
          run({ status: "returning", phase: "awaiting_clearance" }, occurredAt)
        )
        break
      case "train.approaching":
      case "train.arrived":
        stops.delete(event.trainId)
        runs.set(
          event.trainId,
          run(
            {
              status: "approaching",
              from: { kind: "depot" },
              toward: event.stationId,
            },
            occurredAt
          )
        )
        break
      case "train.blocked": {
        const motion = runs.get(event.trainId)
        if (!motion || stops.has(event.trainId)) break
        stops.set(event.trainId, {
          motion,
          at: Date.parse(occurredAt),
          toward: "toward" in motion.state ? motion.state.toward : null,
        })
        break
      }
      case "train.unloaded":
      case "train.sided":
        stops.delete(event.trainId)
        runs.delete(event.trainId)
    }
  }
  return new Map([...stops].map(([id, { motion, at }]) => [id, { motion, at }]))
}

/** True while a Train waits for the user to approve its unload. */
export const awaitingApproval = (state: TrainState) =>
  state.status === "held" &&
  state.reasons.some((reason) => reason.kind === "awaiting_user_approval")

/** Where a Train is drawn while it is not moving. */
function restingDistance(state: TrainState, route: RouteLayout): number | null {
  const station = (id: string) =>
    route.stationDistances[
      (route.stopStationIds ?? route.line.stationIds).indexOf(id)
    ] ?? 0
  switch (state.status) {
    case "unloaded":
      // Into Terminus (or the Junction), where the track ends.
      return route.track.length
    case "siding":
      return null
    case "held":
    case "blocked":
      return restingDistance(state.resume, route)
    case "ready":
      return state.at.kind === "station" ? station(state.at.stationId) : 0
    case "docked":
    case "reviewing":
      return station(state.at)
    case "in_transit":
      return leg(route, state.toward).wait
    case "approaching":
      return leg(route, state.toward).to
    case "returning":
      return leg(route, null).wait
  }
}

/**
 * A Train's distance along its route at time `now`, or null when it is off the
 * track. Motion is presentation only and never claims progress the backend has
 * not reported: a Train in transit eases toward a point short of the next
 * Station and waits there, reaching the Station only once its work is ready
 * (`approaching`). Terminus is no different: a returning Train runs on from
 * its last Station, waits outside, and enters once it unloads. A held or
 * blocked Train stays where it was when it stopped, and so does a cleared one
 * until its block resolves. The renderer eases the drawn Train toward this
 * target, which produces the arrival run however briefly `approaching` lasts.
 */
export function trainDistance(
  motion: TrainMotion,
  route: RouteLayout,
  now: number
): number | null {
  const { state, previous, stop } = motion
  if (stop && stopped(motion)) return trainDistance(stop.motion, route, stop.at)
  const seconds = secondsBetween(motion.stateEnteredAt, now)
  switch (state.status) {
    case "in_transit":
      return transitDistance(leg(route, state.toward), seconds)
    case "returning":
      // Released from a hold at the Terminus gate, it sets off again.
      return transitDistance(leg(route, null), seconds)
    case "held":
    case "blocked":
      return previous && previous.state.status !== state.status
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
  if (stopped(motion)) return false
  return ["in_transit", "returning"].includes(motion.state.status)
}

const snapshotIdentities = new WeakMap<
  Pick<NetworkSnapshot, "lines">,
  Map<string, LineIdentity>
>()
/** Every Line's identity in this snapshot, computed once per snapshot. */
export function identitiesOf(snapshot: NetworkSnapshot) {
  let identities = snapshotIdentities.get(snapshot)
  if (!identities) {
    identities = lineIdentities(snapshot)
    snapshotIdentities.set(snapshot, identities)
  }
  return identities
}

/** The number and colour a Line is drawn with. */
export function lineBadge(snapshot: NetworkSnapshot, lineId: string) {
  const identity = identitiesOf(snapshot).get(lineId)
  return identity
    ? { number: identity.slot + 1, color: lineColor(identity.color) }
    : null
}
