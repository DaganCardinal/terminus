export type Point = { x: number; y: number }

type Piece =
  | { kind: "line"; from: Point; to: Point; start: number; length: number }
  | {
      kind: "arc"
      center: Point
      radius: number
      /** Angle of the arc's first point, measured from its center. */
      angle: number
      /** Signed sweep in radians; positive turns clockwise on screen. */
      sweep: number
      start: number
      length: number
    }

/** A polyline drawn the way transit diagrams draw it: straight runs joined by
 * circular curves, never by a hard corner. */
export interface Track {
  d: string
  length: number
  pieces: Piece[]
  /** Distance along the track at each polyline vertex that is not a curve. */
  vertexDistance: (number | undefined)[]
}

const round = (n: number) => Math.round(n * 100) / 100

/** `radius(i)` is the curve radius wanted at vertex `i`. A curve shrinks only
 * when its neighbours leave too little straight track to fit it. */
export function roundTrack(
  points: Point[],
  radius: (vertex: number) => number
): Track {
  const n = points.length
  const lengths: number[] = []
  const dirs: Point[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]!.x - points[i]!.x
    const dy = points[i + 1]!.y - points[i]!.y
    const length = Math.hypot(dx, dy)
    lengths.push(length)
    dirs.push(length ? { x: dx / length, y: dy / length } : { x: 1, y: 0 })
  }
  const halfTan = new Array<number>(n).fill(0)
  const tangent = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const u = dirs[i - 1]!,
      v = dirs[i]!
    const turn = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)))
    if (turn < 1e-3) continue
    halfTan[i] = Math.tan(turn / 2)
    tangent[i] = radius(i) * halfTan[i]!
  }
  for (let s = 0; s < n - 1; s++) {
    const needed = tangent[s]! + tangent[s + 1]!
    if (needed > lengths[s]!) {
      const scale = lengths[s]! / needed
      tangent[s]! *= scale
      tangent[s + 1]! *= scale
    }
  }

  const pieces: Piece[] = []
  const vertexDistance: (number | undefined)[] = [0]
  let cursor = points[0]!
  let distance = 0
  let d = `M${round(cursor.x)},${round(cursor.y)}`
  for (let i = 1; i < n; i++) {
    const corner = points[i]!
    const u = dirs[i - 1]!
    const curved = i < n - 1 && tangent[i]! > 0
    const enter = curved
      ? { x: corner.x - u.x * tangent[i]!, y: corner.y - u.y * tangent[i]! }
      : corner
    const run = Math.hypot(enter.x - cursor.x, enter.y - cursor.y)
    if (run > 0.01) {
      pieces.push({
        kind: "line",
        from: cursor,
        to: enter,
        start: distance,
        length: run,
      })
      d += ` L${round(enter.x)},${round(enter.y)}`
      distance += run
    }
    if (!curved) {
      vertexDistance[i] = distance
      cursor = enter
      continue
    }
    const v = dirs[i]!
    const r = tangent[i]! / halfTan[i]!
    const turn = 2 * Math.atan(halfTan[i]!)
    const clockwise = u.x * v.y - u.y * v.x > 0
    const normal = clockwise ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x }
    const center = { x: enter.x + normal.x * r, y: enter.y + normal.y * r }
    const exit = {
      x: corner.x + v.x * tangent[i]!,
      y: corner.y + v.y * tangent[i]!,
    }
    pieces.push({
      kind: "arc",
      center,
      radius: r,
      angle: Math.atan2(enter.y - center.y, enter.x - center.x),
      sweep: clockwise ? turn : -turn,
      start: distance,
      length: r * turn,
    })
    d += ` A${round(r)},${round(r)} 0 0 ${clockwise ? 1 : 0} ${round(exit.x)},${round(exit.y)}`
    distance += r * turn
    cursor = exit
  }
  return { d, length: distance, pieces, vertexDistance }
}

export function pointOnTrack(track: Track, distance: number): Point {
  const at = Math.max(0, Math.min(track.length, distance))
  const piece =
    track.pieces.find((p) => at <= p.start + p.length) ?? track.pieces.at(-1)
  if (!piece) return { x: 0, y: 0 }
  const t = piece.length ? (at - piece.start) / piece.length : 0
  if (piece.kind === "line")
    return {
      x: piece.from.x + (piece.to.x - piece.from.x) * t,
      y: piece.from.y + (piece.to.y - piece.from.y) * t,
    }
  const angle = piece.angle + piece.sweep * t
  return {
    x: piece.center.x + piece.radius * Math.cos(angle),
    y: piece.center.y + piece.radius * Math.sin(angle),
  }
}

/** The SVG path of the track between two distances along it. */
export function trackSection(track: Track, from: number, to: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(track.length, n))
  const [a, b] = [clamp(from), clamp(to)]
  const point = (p: Point) => `${round(p.x)},${round(p.y)}`
  let d = `M${point(pointOnTrack(track, a))}`
  for (const piece of track.pieces) {
    const end = Math.min(b, piece.start + piece.length)
    if (end <= Math.max(a, piece.start)) continue
    const to = point(pointOnTrack(track, end))
    if (piece.kind === "line") d += ` L${to}`
    else {
      const r = round(piece.radius)
      d += ` A${r},${r} 0 0 ${piece.sweep > 0 ? 1 : 0} ${to}`
    }
  }
  return d
}

/** Distance ranges on horizontal straight track, at least `clearance` from
 * any curve. Stations are only placed here, as on a real diagram. */
export function straightRuns(
  track: Track,
  from: number,
  to: number,
  clearance: number
): [number, number][] {
  const runs: [number, number][] = []
  track.pieces.forEach((piece, i) => {
    if (piece.kind !== "line" || Math.abs(piece.from.y - piece.to.y) > 0.01)
      return
    const start =
      piece.start + (track.pieces[i - 1]?.kind === "arc" ? clearance : 0)
    const end =
      piece.start +
      piece.length -
      (track.pieces[i + 1]?.kind === "arc" ? clearance : 0)
    const a = Math.max(start, from),
      b = Math.min(end, to)
    if (b - a > 0.5) runs.push([a, b])
  })
  return runs
}
