import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { Minus, Plus, Scan } from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import {
  BULLET_OFFSET,
  HUB_RADIUS,
  TRACK_WIDTH,
  layoutNetwork,
  trainPoint,
} from "./layout"

export type MapSelection = { lineId: string; stationId?: string }
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

const words = (text: string) => text.replaceAll("_", " ")
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
  selection,
  onSelect,
  onClear,
  insets,
  compactKey,
}: {
  snapshot: NetworkSnapshot
  selection: MapSelection | null
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

  const { width, height, hub, hubHalfHeight, routes } = layoutNetwork(
    snapshot.lines
  )
  const fitted = manual === null
  const view = manual ?? fitView(size, { width, height }, insets)
  const sided = snapshot.trains.filter(
    ({ train }) => train.state.status === "siding"
  )
  const capsule = hubHalfHeight > HUB_RADIUS

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
          <title>{`${snapshot.network.name} railway network`}</title>
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
            {routes.map((route) => {
              const { line, color, track, depot, side } = route
              const views = snapshot.trains.filter(
                ({ train }) => train.lineId === line.id
              )
              const dimmed = selection !== null && selection.lineId !== line.id
              const outward = side === "left" ? -1 : 1
              const bullet = {
                x: depot.x + outward * BULLET_OFFSET,
                y: depot.y,
              }
              const name = wrap(line.name, 13, 2)
              return (
                <g
                  key={line.id}
                  className={dimmed ? "route route-dimmed" : "route"}
                >
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
                    <title>{line.name}</title>
                    <rect
                      x={bullet.x - 70}
                      y={depot.y - 70}
                      width="140"
                      height="90"
                      fill="transparent"
                    />
                    <text
                      x={bullet.x}
                      y={depot.y - 26 - (name.length - 1) * 18}
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
                      y={depot.y - 14}
                      width="42"
                      height="28"
                      rx="14"
                      fill={color}
                    />
                    <text
                      x={bullet.x}
                      y={depot.y + 5.5}
                      className="route-number"
                    >
                      {route.number.toString().padStart(2, "0")}
                    </text>
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
                  </g>
                  {line.stationIds.map((id, i) => {
                    const station = snapshot.stations.find((s) => s.id === id)
                    if (!station) return null
                    const p = route.stations[i]!
                    const status = station.state.status
                    const active = ![
                      "waiting",
                      "complete",
                      "cancelled",
                    ].includes(status)
                    const chosen = selection?.stationId === id
                    const showStatus = status !== "waiting"
                    const label = wrap(station.name, 16, 3)
                    const nameBaseline =
                      p.y - LABEL_GAP - (showStatus ? STATUS_LEADING : 0)
                    return (
                      <g
                        key={id}
                        role="button"
                        tabIndex={0}
                        className="map-target station"
                        aria-label={`${station.name}, ${words(status)}`}
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
                        <title>{`${station.name} · ${words(status)}`}</title>
                        {(active || chosen) && (
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r="13"
                            fill="var(--map-paper)"
                            stroke={chosen ? "var(--map-ink)" : color}
                            strokeWidth="2"
                            strokeDasharray={chosen ? undefined : "3 3"}
                          />
                        )}
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="7"
                          fill={
                            status === "complete" ? color : "var(--map-paper)"
                          }
                          stroke={
                            status === "blocked" ? "var(--map-danger)" : color
                          }
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
                            y={p.y - LABEL_GAP}
                            textAnchor="middle"
                            className={`station-state ${status === "blocked" ? "state-blocked" : ""}`}
                          >
                            {words(status)}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  {views.map((view) => {
                    const p = trainPoint(view.train.state, route)
                    if (!p) return null
                    const status = view.train.state.status
                    const label = words(status)
                    // Icon, label and signal lamp sized to the label's length.
                    const half = 30 + label.length * 3.4
                    return (
                      <g
                        key={view.train.id}
                        className={`map-target train-marker train-${status}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${line.name} Train, ${label}, signal ${view.signal ?? "not available"}`}
                        onClick={() => onSelect({ lineId: line.id })}
                        onKeyDown={(e) =>
                          keyboard(e, () => onSelect({ lineId: line.id }))
                        }
                      >
                        <rect
                          className="train-hitbox"
                          x={p.x - half - 4}
                          y={p.y + 8}
                          width={half * 2 + 8}
                          height="56"
                          fill="transparent"
                        />
                        <title>
                          {`Train · ${label} · ${view.train.carIds.length} Cars`}
                        </title>
                        <path
                          d={`M${p.x},${p.y + 15} V${p.y + 36}`}
                          className="train-leader"
                        />
                        <rect
                          className="train-body"
                          x={p.x - half}
                          y={p.y + 36}
                          width={half * 2}
                          height="26"
                          rx="13"
                        />
                        <g
                          transform={`translate(${p.x - half + 11},${p.y + 42})`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="train-icon"
                          aria-hidden="true"
                        >
                          <rect width="11" height="11" rx="2" />
                          <path d="M2 3h7v3.5H2z M2.5 14l1.5-2.5 M8.5 14L7 11.5" />
                        </g>
                        <text
                          x={p.x + (view.signal ? 0 : 6)}
                          y={p.y + 53.5}
                          className="train-label"
                        >
                          {label}
                        </text>
                        {view.signal && (
                          <circle
                            cx={p.x + half - 13}
                            cy={p.y + 49}
                            r="4"
                            className={`train-signal signal-${view.signal}`}
                          />
                        )}
                      </g>
                    )
                  })}
                </g>
              )
            })}
            <g className="terminus-hub">
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
                  <rect
                    x={hub.x - HUB_RADIUS + 9}
                    y={hub.y - hubHalfHeight + 9}
                    width={HUB_RADIUS * 2 - 18}
                    height={hubHalfHeight * 2 - 18}
                    rx={HUB_RADIUS - 9}
                    fill="var(--map-ink)"
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
                  <circle
                    cx={hub.x}
                    cy={hub.y}
                    r={HUB_RADIUS - 9}
                    fill="var(--map-ink)"
                  />
                </>
              )}
              <text x={hub.x} y={hub.y + 10} className="hub-letter">
                T
              </text>
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
        <span>
          <i className="key-signal" /> Red signal
        </span>
      </div>
    </details>
  )
}
