import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { Minus, Plus, Scan } from "lucide-react"
import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import logomark from "@/assets/terminus-logomark.svg"
import logomarkWhite from "@/assets/terminus-logomark-white.svg"
import { statusWords } from "@/views/describe"
import {
  BULLET_OFFSET,
  HUB_RADIUS,
  TRACK_WIDTH,
  awaitingApproval,
  clearingBlock,
  identitiesOf,
  layoutNetwork,
  leg,
  trainDistance,
  trainStops,
  type TrainMotion,
} from "./layout"
import { useSignalPulses } from "./use-signal-pulses"
import { useTrainMotion } from "./use-train-motion"

export type MapSelection = {
  lineId: string
  stationId?: string
  junctionId?: string
}
/** Screen space kept clear of floating UI when fitting the network. */
export type MapInsets = {
  top: number
  right: number
  bottom: number
  left: number
}
/** Screen = world × k + (x, y). Pan and zoom are visual state only. */
type View = { x: number; y: number; k: number }
type Size = { width: number; height: number }

const MIN_SCALE = 0.15
const MAX_SCALE = 2.5
const FIT_MAX_SCALE = 1.25
const DRAG_THRESHOLD = 4
const KEY_PAN = 80
const ZOOM_STEP = 1.25

const clamp = (k: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))

function fitView(size: Size, content: Size, insets: MapInsets): View {
  const width = Math.max(80, size.width - insets.left - insets.right)
  const height = Math.max(80, size.height - insets.top - insets.bottom)
  const k = Math.min(
    FIT_MAX_SCALE,
    clamp(Math.min(width / content.width, height / content.height))
  )
  return {
    k,
    x: insets.left + (width - content.width * k) / 2,
    y: insets.top + (height - content.height * k) / 2,
  }
}

function zoomAround(view: View, factor: number, cx: number, cy: number): View {
  const k = clamp(view.k * factor)
  const f = k / view.k
  return { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f }
}

function keyboard(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    action()
  }
}
function wrap(value: string, width: number, max: number): string[] {
  const lines = [""]
  for (const word of value.split(/\s+/)) {
    if (lines.at(-1)!.length + word.length > width && lines.at(-1))
      lines.push(word)
    else lines[lines.length - 1] += `${lines.at(-1) ? " " : ""}${word}`
  }
  const kept = lines.slice(0, max)
  if (lines.length > max)
    kept[max - 1] = `${kept[max - 1]!.slice(0, width - 1)}…`
  return kept.map((line) =>
    line.length > width + 2 ? `${line.slice(0, width)}…` : line
  )
}

const LABEL_GAP = 21
const LABEL_LEADING = 19
const STATUS_LEADING = 17

/** The network as a full-bleed canvas: drag to pan, wheel or pinch to zoom.
 * Until the user moves it, the map stays fitted to the space between the
 * floating panels. */
export function NetworkMap({
  snapshot,
  events,
  selection,
  terminusSelected,
  onSelectTerminus,
  onSelect,
  onClear,
  insets,
  compactKey,
}: {
  snapshot: NetworkSnapshot
  /** The event log, from which the map learns where blocked Trains stopped. */
  events: EventEnvelope[]
  selection: MapSelection | null
  terminusSelected: boolean
  onSelectTerminus: () => void
  onSelect: (selection: MapSelection) => void
  onClear: () => void
  insets: MapInsets
  compactKey: boolean
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [manual, setManual] = useState<View | null>(null)
  const [dragging, setDragging] = useState(false)
  const [smooth, setSmooth] = useState(true)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({ startX: 0, startY: 0, moved: false })
  const suppressClick = useRef(false)

  /** Trains seen running this session. Only these run into Terminus when
   * they unload, so a reload never replays an old arrival. */
  const [seenOnTrack, setSeenOnTrack] = useState(() => new Set<string>())
  const running = snapshot.trains
    .filter(({ train }) => !["unloaded", "siding"].includes(train.state.status))
    .map(({ train }) => train.id)
  if (running.some((id) => !seenOnTrack.has(id)))
    setSeenOnTrack(new Set([...seenOnTrack, ...running]))
  /** Unloaded Trains whose run into Terminus has finished. */
  const [arrived, setArrived] = useState(() => new Set<string>())

  // Finished Lines leave the live map and give their slot, colour and shape
  // to the next Line laid. One still watching its Train run into Terminus
  // stays, fading out, until the Train arrives.
  const identities = identitiesOf(snapshot)
  const isLive = (lineId: string) => identities.get(lineId)?.live ?? true
  const retiring = (lineId: string) =>
    !isLive(lineId) &&
    snapshot.trains.some(
      ({ train }) =>
        train.lineId === lineId &&
        train.state.status === "unloaded" &&
        seenOnTrack.has(train.id) &&
        !arrived.has(train.id)
    )
  const liveLines = snapshot.lines.filter(
    (line) => isLive(line.id) || retiring(line.id)
  )
  const finishedLines = snapshot.lines
    .filter((line) => !isLive(line.id))
    .sort((a, b) =>
      identities
        .get(b.id)!
        .finishedAt!.localeCompare(identities.get(a.id)!.finishedAt!)
    )
  const [mode, setMode] = useState<"live" | "finished">("live")
  const shown = finishedLines.length > 0 ? mode : "live"
  // Selecting a Line from elsewhere (the siding, a drawer, an alert) shows
  // the view that draws it.
  const [followed, setFollowed] = useState(selection?.lineId)
  if (selection?.lineId !== followed) {
    setFollowed(selection?.lineId)
    if (selection && identities.has(selection.lineId))
      setMode(
        liveLines.some((line) => line.id === selection.lineId)
          ? "live"
          : "finished"
      )
  }
  const { width, height, hub, hubHalfHeight, routes, junctions, interchanges } =
    shown === "live"
      ? layoutNetwork(liveLines, identities)
      : layoutNetwork(finishedLines, identities, "order")
  /** The selected Line dims the others only while it is drawn. */
  const focus =
    selection && routes.some((route) => route.line.id === selection.lineId)
      ? selection.lineId
      : null
  const routeClass = (lineId: string) =>
    [
      "route",
      focus !== null && focus !== lineId && "route-dimmed",
      shown === "live" && !isLive(lineId) && "route-retiring",
    ]
      .filter(Boolean)
      .join(" ")
  /** Labels rise above receivers' lanes that pass over their Station. */
  const labelLift = new Map(
    interchanges.map((c) => [
      c.stationId,
      Math.max(
        0,
        ...c.lanes
          .filter((lane) => !lane.remote)
          .map((lane) => c.at.y - lane.point.y)
      ),
    ])
  )
  const fitted = manual === null
  const view = manual ?? fitView(size, { width, height }, insets)
  const sided = snapshot.trains.filter(
    ({ train }) => train.state.status === "siding"
  )
  const awaitingReview = snapshot.trains.filter(({ train }) =>
    awaitingApproval(train.state)
  )
  const capsule = hubHalfHeight > HUB_RADIUS
  const stops = trainStops(events)
  const motionOf = (view: NetworkSnapshot["trains"][number]): TrainMotion => ({
    ...view,
    state: view.train.state,
    stop: stops.get(view.train.id) ?? null,
  })
  const moving = routes.flatMap((route) =>
    snapshot.trains
      .filter(({ train }) => train.lineId === route.line.id)
      .map((view) => ({ id: view.train.id, motion: motionOf(view), route }))
  )
  const trainRef = useTrainMotion(moving)
  // The Engineer's signal runs from where the Train set off to its Station.
  const pulseLayer = useSignalPulses(
    moving.map(({ id, motion, route }) => {
      const { state, stateEnteredAt } = motion
      const from =
        state.status === "in_transit" &&
        trainDistance(motion, route, Date.parse(stateEnteredAt))
      return {
        id,
        stateEnteredAt,
        signal:
          state.status === "in_transit" && typeof from === "number"
            ? { track: route.track, from, to: leg(route, state.toward).to }
            : null,
      }
    })
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  const local = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }
  const change = (next: (current: View) => View, animate: boolean) => {
    setSmooth(animate)
    setManual((current) => next(current ?? view))
  }
  const center = () => ({
    x: (insets.left + size.width - insets.right) / 2,
    y: (insets.top + size.height - insets.bottom) / 2,
  })
  const zoomBy = (factor: number) => {
    const c = center()
    change((v) => zoomAround(v, factor, c.x, c.y), true)
  }
  const fit = () => {
    setSmooth(true)
    setManual(null)
  }
  const show = (next: "live" | "finished") => {
    setMode(next)
    fit()
  }

  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault()
    const p = local(event.clientX, event.clientY)
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    change((v) => zoomAround(v, Math.exp(-delta * 0.0018), p.x, p.y), false)
  })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const listener = (event: WheelEvent) => onWheel(event)
    canvas.addEventListener("wheel", listener, { passive: false })
    return () => canvas.removeEventListener("wheel", listener)
  }, [])

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
    if (pointers.current.size === 1) {
      suppressClick.current = false
      gesture.current = {
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      }
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const next = { x: event.clientX, y: event.clientY }
    if (pointers.current.size === 1) {
      if (
        !gesture.current.moved &&
        Math.hypot(
          next.x - gesture.current.startX,
          next.y - gesture.current.startY
        ) > DRAG_THRESHOLD
      ) {
        gesture.current.moved = true
        // Capture only once dragging, so plain clicks still reach Stations.
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }
      pointers.current.set(event.pointerId, next)
      if (gesture.current.moved)
        change(
          (v) => ({
            ...v,
            x: v.x + next.x - previous.x,
            y: v.y + next.y - previous.y,
          }),
          false
        )
      return
    }
    // Two fingers: zoom by the change in spread around their midpoint.
    const other = [...pointers.current.entries()].find(
      ([id]) => id !== event.pointerId
    )?.[1]
    pointers.current.set(event.pointerId, next)
    if (!other) return
    gesture.current.moved = true
    const before = Math.hypot(previous.x - other.x, previous.y - other.y)
    const after = Math.hypot(next.x - other.x, next.y - other.y)
    const mid = local((next.x + other.x) / 2, (next.y + other.y) / 2)
    const shift = { x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2 }
    change((v) => {
      const zoomed = zoomAround(
        v,
        before > 0 ? after / before : 1,
        mid.x,
        mid.y
      )
      return { ...zoomed, x: zoomed.x + shift.x, y: zoomed.y + shift.y }
    }, false)
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return
    if (pointers.current.size === 0) {
      suppressClick.current = gesture.current.moved
      setDragging(false)
    }
  }

  function canvasKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const pan = (dx: number, dy: number) =>
      change((v) => ({ ...v, x: v.x + dx, y: v.y + dy }), true)
    const actions: Record<string, () => void> = {
      ArrowLeft: () => pan(KEY_PAN, 0),
      ArrowRight: () => pan(-KEY_PAN, 0),
      ArrowUp: () => pan(0, KEY_PAN),
      ArrowDown: () => pan(0, -KEY_PAN),
      "+": () => zoomBy(ZOOM_STEP),
      "=": () => zoomBy(ZOOM_STEP),
      "-": () => zoomBy(1 / ZOOM_STEP),
      "0": fit,
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <section className="map-panel" aria-label="Network map">
      <div
        ref={canvasRef}
        className={`map-canvas ${dragging ? "map-dragging" : ""}`}
        tabIndex={0}
        aria-label="Network diagram. Drag or use arrow keys to pan, scroll or use plus and minus to zoom, 0 to fit."
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onKeyDown={canvasKey}
        onClickCapture={(event) => {
          if (!suppressClick.current) return
          suppressClick.current = false
          event.stopPropagation()
          event.preventDefault()
        }}
      >
        <svg
          className="railway-map"
          aria-label="Lines run from their depots toward Terminus"
        >
          <defs>
            <pattern
              id="map-dots"
              width="28"
              height="28"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="14" cy="14" r="1.2" className="map-dot" />
            </pattern>
          </defs>
          <g
            // Remount once measured so the first fit doesn't animate in.
            key={size.width > 0 ? "measured" : "unmeasured"}
            className={`map-world ${fitted || smooth ? "map-smooth" : ""}`}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              visibility: size.width > 0 ? undefined : "hidden",
            }}
          >
            <rect
              x={-20000}
              y={-20000}
              width={40000 + width}
              height={40000 + height}
              fill="url(#map-dots)"
              onClick={onClear}
            />
            {/* Paint every track before shared Station markers. */}
            {routes.map(({ line, track, color }) => (
              <g key={`track-${line.id}`} className={routeClass(line.id)}>
                <path
                  d={track.d}
                  className="track-casing"
                  strokeWidth={TRACK_WIDTH + 6}
                />
                <path
                  d={track.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={TRACK_WIDTH}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}
            <g ref={pulseLayer} aria-hidden="true" />
            {interchanges.map((c) => {
              const ys = [
                c.at.y,
                ...c.lanes
                  .filter((lane) => !lane.remote)
                  .map((lane) => lane.point.y),
              ]
              const top = Math.min(...ys)
              return (
                <g key={`interchange-${c.stationId}`} aria-hidden="true">
                  {c.lanes
                    .filter((lane) => lane.remote)
                    .map((lane) => (
                      <path
                        key={`link-${lane.crossingId}`}
                        d={`M${c.at.x},${c.at.y} L${lane.point.x},${lane.point.y}`}
                        stroke="var(--map-ink)"
                        strokeWidth={2}
                        strokeDasharray="4 5"
                        fill="none"
                      />
                    ))}
                  <rect
                    x={c.at.x - 10}
                    y={top - 10}
                    width={20}
                    height={Math.max(...ys) - top + 20}
                    rx={10}
                    fill="var(--map-paper)"
                    stroke="var(--map-ink)"
                    strokeWidth={2.5}
                  />
                  {c.lanes.map((lane) => {
                    const route = routes.find((r) => r.line.id === lane.lineId)
                    const status = (snapshot.crossings ?? []).find(
                      (x) => x.id === lane.crossingId
                    )?.state.status
                    const tone =
                      status === "blocked"
                        ? "var(--map-danger)"
                        : (route?.color ?? "var(--map-ink)")
                    return (
                      <circle
                        key={lane.crossingId}
                        cx={lane.point.x}
                        cy={lane.point.y}
                        r={5}
                        fill={status === "complete" ? tone : "var(--map-paper)"}
                        stroke={tone}
                        strokeWidth={3}
                      />
                    )
                  })}
                </g>
              )
            })}
            {junctions.map(({ id, point, halfHeight }) => {
              const j = (snapshot.junctions ?? []).find((x) => x.id === id)
              if (!j) return null
              const name = wrap(j.name, 16, 2)
              return (
                <g
                  key={j.id}
                  role="button"
                  tabIndex={0}
                  className="map-target"
                  aria-label={`Select Junction ${j.name}, ${j.state.status}`}
                  onClick={() =>
                    onSelect({ lineId: j.outgoingLineId, junctionId: j.id })
                  }
                  onKeyDown={(e) =>
                    keyboard(e, () =>
                      onSelect({ lineId: j.outgoingLineId, junctionId: j.id })
                    )
                  }
                >
                  <title>{j.name}</title>
                  <rect
                    x={point.x - 28}
                    y={point.y - halfHeight}
                    width={56}
                    height={halfHeight * 2}
                    rx={12}
                    fill="var(--map-paper)"
                    stroke="var(--map-ink)"
                    strokeWidth={3}
                  />
                  <text
                    x={point.x}
                    y={point.y + 10}
                    textAnchor="middle"
                    className="hub-letter"
                    style={{ fill: "var(--map-ink)" }}
                  >
                    J
                  </text>
                  {/* Above the marker: below it is where the outgoing Train waits. */}
                  <text
                    x={point.x}
                    y={point.y - halfHeight - 30 - (name.length - 1) * 18}
                    textAnchor="middle"
                    className="route-name"
                  >
                    {name.map((text, k) => (
                      <tspan key={k} x={point.x} dy={k === 0 ? 0 : 18}>
                        {text}
                      </tspan>
                    ))}
                  </text>
                  <text
                    x={point.x}
                    y={point.y - halfHeight - 12}
                    textAnchor="middle"
                    className="station-state"
                  >
                    {j.state.status === "ready"
                      ? "Awaiting release"
                      : statusWords(j.state.status)}{" "}
                    · {j.inputs.length}/{j.incomingTrainIds.length}
                  </text>
                </g>
              )
            })}
            {routes.map((route) => {
              const { line, color, depot, side } = route
              const views = snapshot.trains.filter(
                ({ train }) => train.lineId === line.id
              )
              const outward = side === "left" ? -1 : 1
              const bullet = route.bullet ?? {
                x: depot.x + outward * BULLET_OFFSET,
                y: depot.y,
              }
              const name = wrap(line.name, 13, 2)
              return (
                <g key={line.id} className={routeClass(line.id)}>
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${line.name}`}
                    aria-pressed={selection?.lineId === line.id}
                    onClick={() => onSelect({ lineId: line.id })}
                    onKeyDown={(e) =>
                      keyboard(e, () => onSelect({ lineId: line.id }))
                    }
                    className="map-target"
                  >
                    <rect
                      x={bullet.x - 70}
                      y={bullet.y - 70}
                      width="140"
                      height="90"
                      fill="transparent"
                    />
                    <text
                      x={bullet.x}
                      y={bullet.y - 26 - (name.length - 1) * 18}
                      textAnchor="middle"
                      className="route-name"
                    >
                      {name.map((text, j) => (
                        <tspan key={j} x={bullet.x} dy={j === 0 ? 0 : 18}>
                          {text}
                        </tspan>
                      ))}
                    </text>
                    <rect
                      x={bullet.x - 21}
                      y={bullet.y - 14}
                      width="42"
                      height="28"
                      rx="14"
                      fill={color}
                    />
                    <text
                      x={bullet.x}
                      y={bullet.y + 5.5}
                      className="route-number"
                    >
                      {route.number.toString().padStart(2, "0")}
                    </text>
                    {line.origin?.kind !== "junction" && (
                      <rect
                        x={depot.x - 7}
                        y={depot.y - 7}
                        width="14"
                        height="14"
                        rx="2"
                        fill="var(--map-paper)"
                        stroke={color}
                        strokeWidth="3"
                      />
                    )}
                  </g>
                  {line.stationIds.map((id, i) => {
                    const station = snapshot.stations.find((s) => s.id === id)
                    if (!station) return null
                    const p =
                      route.stations[
                        route.stopStationIds
                          ? route.stopStationIds.indexOf(id)
                          : i
                      ]!
                    const status = station.state.status
                    const blocked = status === "blocked"
                    const working = ![
                      "waiting",
                      "complete",
                      "cancelled",
                      "blocked",
                    ].includes(status)
                    const chosen = selection?.stationId === id
                    // The dot, spinner and check show every other state.
                    const showStatus = blocked
                    const label = wrap(station.name, 16, 3)
                    const pickups = (snapshot.crossings ?? [])
                      .filter((c) => c.sourceStationId === id)
                      .map(
                        (c) =>
                          `, pickup by ${snapshot.lines.find((l) => l.id === c.lineId)?.name ?? "Line"} ${statusWords(c.state.status)}`
                      )
                      .join("")
                    const lift = labelLift.get(id) ?? 0
                    const nameBaseline =
                      p.y - lift - LABEL_GAP - (showStatus ? STATUS_LEADING : 0)
                    return (
                      <g
                        key={id}
                        role="button"
                        tabIndex={0}
                        className="map-target station"
                        aria-label={`${station.name}, ${statusWords(status)}${pickups}`}
                        aria-pressed={chosen}
                        onClick={() =>
                          onSelect({ lineId: line.id, stationId: id })
                        }
                        onKeyDown={(e) =>
                          keyboard(e, () =>
                            onSelect({ lineId: line.id, stationId: id })
                          )
                        }
                      >
                        <rect
                          x={p.x - 74}
                          y={p.y - 104}
                          width="148"
                          height="122"
                          fill="transparent"
                        />
                        {(working || blocked || chosen) && (
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r="13"
                            fill="var(--map-paper)"
                            stroke={
                              chosen
                                ? "var(--map-ink)"
                                : blocked
                                  ? "var(--map-danger)"
                                  : color
                            }
                            strokeOpacity={chosen || blocked ? 1 : 0.22}
                            strokeWidth="2"
                          />
                        )}
                        {working && (
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r="13"
                            fill="none"
                            stroke={color}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            // An arc of about a quarter of the ring.
                            strokeDasharray="22 60"
                            className="station-spinner"
                          />
                        )}
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="7"
                          fill={
                            status === "complete" ? color : "var(--map-paper)"
                          }
                          stroke={blocked ? "var(--map-danger)" : color}
                          strokeWidth="3"
                        />
                        {status === "complete" && (
                          <path
                            d={`M${p.x - 3},${p.y} l2,2 l4,-4`}
                            stroke="white"
                            strokeWidth="1.5"
                            fill="none"
                          />
                        )}
                        <text
                          x={p.x}
                          y={nameBaseline - (label.length - 1) * LABEL_LEADING}
                          textAnchor="middle"
                          className="station-label"
                        >
                          {label.map((text, j) => (
                            <tspan
                              key={j}
                              x={p.x}
                              dy={j === 0 ? 0 : LABEL_LEADING}
                            >
                              {text}
                            </tspan>
                          ))}
                        </text>
                        {showStatus && (
                          <text
                            x={p.x}
                            y={p.y - lift - LABEL_GAP}
                            textAnchor="middle"
                            className="station-state state-blocked"
                          >
                            {statusWords(status)}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  {views.map((view) => {
                    const { id } = view.train
                    const status = view.train.state.status
                    if (status === "siding") return null
                    if (status === "unloaded") {
                      if (!seenOnTrack.has(id) || arrived.has(id)) return null
                    }
                    const clearing = clearingBlock(motionOf(view))
                    const label = clearing
                      ? "clearing block"
                      : awaitingApproval(view.train.state)
                        ? "awaiting approval"
                        : statusWords(status)
                    // The Train is a dot on the track, tinted by its status,
                    // with its label hung below. Both are drawn around the
                    // Train's track position, which useTrainMotion sets as
                    // the group's transform.
                    const half = 13 + label.length * 3.4
                    return (
                      <g
                        key={id}
                        ref={trainRef(id)}
                        className={`map-target train-marker train-${status} ${clearing ? "train-clearing" : ""}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${line.name} Train, ${label}, signal ${view.signal ?? "not available"}`}
                        onClick={() => onSelect({ lineId: line.id })}
                        onKeyDown={(e) =>
                          keyboard(e, () => onSelect({ lineId: line.id }))
                        }
                        onAnimationEnd={(e) => {
                          if (e.animationName === "train-arrive")
                            setArrived((done) => new Set(done).add(id))
                        }}
                      >
                        <rect
                          className="train-hitbox"
                          x={-half - 4}
                          y={8}
                          width={half * 2 + 8}
                          height="50"
                          fill="transparent"
                        />
                        <path d="M0,13 V30" className="train-leader" />
                        <rect
                          className="train-body"
                          x={-half}
                          y={30}
                          width={half * 2}
                          height="24"
                          rx="12"
                        />
                        <text x={0} y={46.5} className="train-label">
                          {label}
                        </text>
                        <circle r="9" className="train-pulse" />
                        <circle r="9" className="train-body train-car" />
                        <circle r="5" className="train-dot" />
                      </g>
                    )
                  })}
                </g>
              )
            })}
            <g
              className="terminus-hub"
              role="button"
              tabIndex={0}
              aria-label="View Terminus"
              aria-pressed={terminusSelected}
              onClick={(event) => {
                event.stopPropagation()
                onSelectTerminus()
              }}
              onKeyDown={(event) => keyboard(event, onSelectTerminus)}
            >
              <rect
                className="hub-focus-ring"
                x={hub.x - HUB_RADIUS - 9}
                y={hub.y - hubHalfHeight - 9}
                width={HUB_RADIUS * 2 + 18}
                height={hubHalfHeight * 2 + 18}
                rx={HUB_RADIUS + 9}
              />
              {capsule ? (
                <>
                  <rect
                    x={hub.x - HUB_RADIUS}
                    y={hub.y - hubHalfHeight}
                    width={HUB_RADIUS * 2}
                    height={hubHalfHeight * 2}
                    rx={HUB_RADIUS}
                    fill="var(--map-paper)"
                    stroke="var(--map-ink)"
                    strokeWidth="4"
                  />
                </>
              ) : (
                <>
                  <circle
                    cx={hub.x}
                    cy={hub.y}
                    r={HUB_RADIUS}
                    fill="var(--map-paper)"
                    stroke="var(--map-ink)"
                    strokeWidth="4"
                  />
                </>
              )}
              <image
                className="logomark-light"
                href={logomark}
                x={hub.x - 32}
                y={hub.y - 32}
                width="64"
                height="64"
                aria-hidden="true"
                pointerEvents="none"
              />
              <image
                className="logomark-dark"
                href={logomarkWhite}
                x={hub.x - 32}
                y={hub.y - 32}
                width="64"
                height="64"
                aria-hidden="true"
                pointerEvents="none"
              />
              <text
                x={hub.x}
                y={hub.y + hubHalfHeight + 32}
                textAnchor="middle"
                className="hub-title"
              >
                Terminus
              </text>
              <text
                x={hub.x}
                y={hub.y + hubHalfHeight + 52}
                textAnchor="middle"
                className="map-secondary"
              >
                CANONICAL PROJECT STATE
              </text>
            </g>
          </g>
        </svg>
      </div>
      <div className="map-overlay map-overlay-bottom-left">
        {finishedLines.length > 0 && (
          <div
            className="map-lines-switch glass"
            role="group"
            aria-label="Lines shown on the map"
          >
            <button
              aria-pressed={shown === "live"}
              onClick={() => show("live")}
            >
              Live{" "}
              <span>{snapshot.lines.filter((l) => isLive(l.id)).length}</span>
            </button>
            <button
              aria-pressed={shown === "finished"}
              onClick={() => show("finished")}
            >
              Finished <span>{finishedLines.length}</span>
            </button>
          </div>
        )}
        {awaitingReview.length > 0 && (
          <div className="siding review-yard" aria-label="Review yard">
            <span className="eyebrow">Review yard</span>
            {awaitingReview.map(({ train }) => (
              <button
                key={train.id}
                onClick={() => onSelect({ lineId: train.lineId })}
              >
                {snapshot.lines.find((line) => line.id === train.lineId)?.name}{" "}
                · awaiting approval
              </button>
            ))}
          </div>
        )}
        {sided.length > 0 && (
          <div className="siding">
            <span className="eyebrow">Siding</span>
            {sided.map(({ train }) => (
              <button
                key={train.id}
                onClick={() => onSelect({ lineId: train.lineId })}
              >
                {snapshot.lines.find((l) => l.id === train.lineId)?.name} ·
                parked
              </button>
            ))}
          </div>
        )}
        <MapKey key={String(compactKey)} compact={compactKey} />
      </div>
      <div className="zoom-controls" aria-label="Zoom">
        <button
          aria-label="Zoom in"
          disabled={view.k >= MAX_SCALE}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <Plus size={16} />
        </button>
        <button
          aria-label="Zoom out"
          disabled={view.k <= MIN_SCALE}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <Minus size={16} />
        </button>
        <button onClick={fit} aria-label="Fit network" aria-pressed={fitted}>
          <Scan size={16} />
        </button>
      </div>
    </section>
  )
}

function MapKey({ compact }: { compact: boolean }) {
  return (
    <details className="map-key glass" open={!compact}>
      <summary>Map key</summary>
      <div>
        <span>
          <i className="key-depot" /> Depot
        </span>
        <span>
          <i className="key-station" /> Station
        </span>
        <span>
          <i className="key-active" /> In progress
        </span>
        <span>
          <i className="key-complete" /> Accepted
        </span>
        <span>
          <i className="key-train" /> Train
        </span>
      </div>
    </details>
  )
}
