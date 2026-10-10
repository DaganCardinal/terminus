import type { Line } from "@terminus/domain"

/** How a Line is drawn: its row slot (its number is `slot + 1`), palette
 * colour and track profile. Display metadata only. It is derived from the
 * network's history on every read and never stored. */
export interface LineIdentity {
  slot: number
  color: number
  shape: number
  /** Still running, or linked by a Crossing or Junction to a Line that is.
   * Linked Lines leave the map together so their layout stays whole. */
  live: boolean
  /** When the Line released its identity for reuse. */
  finishedAt?: string
}

export const LINE_COLOR_COUNT = 8
export const ROUTE_SHAPE_COUNT = 6
/** Lines named after a palette colour keep it when it is free. */
const namedColors: Record<string, number> = {
  red: 0,
  blue: 1,
  green: 2,
  purple: 3,
  orange: 4,
}

export interface LineHistory {
  network: { createdAt: string }
  /** In creation order. */
  lines: Line[]
  /** When each Line was laid (ISO 8601). */
  lineCreatedAt?: Record<string, string>
  trains: {
    train: { lineId: string; state: { status: string } }
    stateEnteredAt: string
  }[]
  junctions?: { id: string; state: { status: string } }[]
}

const terminal = new Set(["unloaded", "siding"])

/** Replays the network's history so a Line keeps one identity for as long as
 * it is live, and a finished Line's slot, colour and shape go back to the
 * pool for the next Line laid. Long-running networks therefore reuse a small
 * set of rows and colours instead of growing forever, and the result is the
 * same on every poll, reload and browser.
 *
 * `planned` Lines are predicted as if laid now, after every existing Line. */
export function lineIdentities(
  history: LineHistory,
  planned: { id: string; name: string }[] = []
): Map<string, LineIdentity> {
  const { lines } = history
  const fallback = Date.parse(history.network.createdAt) || 0
  const time = (iso: string | undefined) => {
    const parsed = iso ? Date.parse(iso) : NaN
    return Number.isNaN(parsed) ? fallback : parsed
  }
  const opened = lines.map((line) => time(history.lineCreatedAt?.[line.id]))
  const junctionStatus = new Map(
    (history.junctions ?? []).map((j) => [j.id, j.state.status])
  )
  /** When the Line's own work stopped; Infinity while it runs. */
  const ended = lines.map((line, i) => {
    const views = history.trains.filter(({ train }) => train.lineId === line.id)
    if (views.length === 0)
      // An outgoing Line has no Train until its Junction releases.
      return line.origin?.kind === "junction" &&
        junctionStatus.get(line.origin.junctionId) === "abandoned"
        ? opened[i]!
        : Infinity
    if (views.some(({ train }) => !terminal.has(train.state.status)))
      return Infinity
    return Math.max(...views.map((view) => time(view.stateEnteredAt)))
  })

  // Lines joined by a Crossing or Junction share a component.
  const parent = lines.map((_, i) => i)
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]!))
  const join = (a: number, b: number) => {
    parent[root(a)] = root(b)
  }
  const owner = new Map<string, number>()
  lines.forEach((line, i) => line.stationIds.forEach((id) => owner.set(id, i)))
  const byJunction = new Map<string, number>()
  lines.forEach((line, i) => {
    for (const stop of line.stops ?? [])
      if (stop.kind === "crossing" && owner.has(stop.stationId))
        join(i, owner.get(stop.stationId)!)
    for (const end of [line.origin, line.destination])
      if (end?.kind === "junction") {
        const first = byJunction.get(end.junctionId)
        if (first === undefined) byJunction.set(end.junctionId, i)
        else join(i, first)
      }
  })

  const identities = new Map<string, LineIdentity>()
  /** Lines currently holding their identity, by id. */
  const holding = new Set<string>()
  const named = (name: string) => namedColors[name.split(" ")[0]!.toLowerCase()]
  /** `claimed` holds the named colours of Lines arriving alongside this one,
   * which an unnamed Line leaves for them while another colour is free. */
  const allocate = (id: string, name: string, claimed: Set<number>) => {
    const held = [...holding].map((holder) => identities.get(holder)!)
    const slots = new Set(held.map((h) => h.slot))
    let slot = 0
    while (slots.has(slot)) slot++
    const leastUsed = (count: number, key: (h: LineIdentity) => number) => {
      const uses = Array.from({ length: count }, () => 0)
      for (const h of held) uses[key(h)]!++
      const min = Math.min(...uses)
      return uses.flatMap((n, k) => (n === min ? [k] : []))
    }
    const colors = leastUsed(LINE_COLOR_COUNT, (h) => h.color)
    const own = named(name)
    const unclaimed = colors.filter((c) => !claimed.has(c))
    const shapes = leastUsed(ROUTE_SHAPE_COUNT, (h) => h.shape)
    return {
      slot,
      color:
        own !== undefined && colors.includes(own)
          ? own
          : (unclaimed[0] ?? colors[0]!),
      shape: shapes[seed(id) % shapes.length]!,
      live: true,
    }
  }

  const moments = [
    ...new Set([...opened, ...ended.filter(Number.isFinite)]),
  ].sort((a, b) => a - b)
  for (const t of moments) {
    const running = new Set<number>()
    lines.forEach((_, i) => {
      if (opened[i]! <= t && ended[i]! > t) running.add(root(i))
    })
    const wanted = (i: number) => opened[i]! <= t && running.has(root(i))
    const release = (id: string) => {
      holding.delete(id)
      identities.set(id, {
        ...identities.get(id)!,
        live: false,
        finishedAt: new Date(t).toISOString(),
      })
    }
    lines.forEach((line, i) => {
      if (holding.has(line.id) && !wanted(i)) release(line.id)
    })
    const arriving = lines.filter(
      (line, i) => !holding.has(line.id) && (wanted(i) || opened[i] === t)
    )
    const claimed = new Set(arriving.flatMap((line) => named(line.name) ?? []))
    lines.forEach((line, i) => {
      // A Line that opens already finished still gets an identity, so it
      // can be drawn among finished Lines.
      if (!arriving.includes(line)) return
      identities.set(line.id, allocate(line.id, line.name, claimed))
      holding.add(line.id)
      if (!wanted(i)) release(line.id)
    })
  }
  // Planned Lines are laid after everything that exists.
  const claimed = new Set(planned.flatMap((line) => named(line.name) ?? []))
  for (const line of planned) {
    identities.set(line.id, allocate(line.id, line.name, claimed))
    holding.add(line.id)
  }
  return identities
}

/** Dispatcher IDs contain random UUID entropy, which seeds each Line's
 * choice of track profile. */
function seed(id: string) {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}
