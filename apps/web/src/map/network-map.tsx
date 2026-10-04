import { useRef, useState, type KeyboardEvent } from "react"
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

export function NetworkMap({
  snapshot,
  selection,
  onSelect,
}: {
  snapshot: NetworkSnapshot
  selection: MapSelection | null
  onSelect: (selection: MapSelection) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [fitted, setFitted] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height, hub, hubHalfHeight, routes } = layoutNetwork(
    snapshot.lines
  )
  const sided = snapshot.trains.filter(
    ({ train }) => train.state.status === "siding"
  )
  const capsule = hubHalfHeight > HUB_RADIUS
  return (
    <section className="map-panel" aria-label="Network map">
      <div
        ref={scrollRef}
        className="map-scroll"
        tabIndex={0}
        aria-label="Scrollable network diagram"
      >
        <svg
          className="railway-map"
          style={{
            width: fitted ? "100%" : `${zoom * 100}%`,
            minWidth: fitted ? undefined : `${720 * zoom}px`,
            maxHeight: fitted ? 640 : undefined,
          }}
          viewBox={`0 0 ${width} ${height}`}
          aria-label="Lines run from their depots toward Terminus"
        >
          <title>{`${snapshot.network.name} railway network`}</title>
          {routes.map((route) => {
            const { line, color, track, depot, side } = route
            const views = snapshot.trains.filter(
              ({ train }) => train.lineId === line.id
            )
            const dimmed = selection !== null && selection.lineId !== line.id
            const outward = side === "left" ? -1 : 1
            const bullet = { x: depot.x + outward * BULLET_OFFSET, y: depot.y }
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
                  <text x={bullet.x} y={depot.y + 5.5} className="route-number">
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
                  const active = !["waiting", "complete", "cancelled"].includes(
                    status
                  )
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
        </svg>
      </div>
      <div className="map-bottom">
        <div className="map-key" aria-label="Map key">
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
        <div className="zoom-controls">
          <button
            aria-label="Zoom out"
            disabled={fitted || zoom <= 0.75}
            onClick={() => {
              setFitted(false)
              setZoom((z) => Math.max(0.75, z - 0.25))
            }}
          >
            <Minus size={15} />
          </button>
          <button
            onClick={() => {
              setFitted(true)
              setZoom(1)
              scrollRef.current?.scrollTo(0, 0)
            }}
            aria-label="Fit network"
            aria-pressed={fitted}
          >
            <Scan size={15} />
            <span>Fit</span>
          </button>
          <button
            aria-label="Zoom in"
            disabled={zoom >= 2}
            onClick={() => {
              setFitted(false)
              setZoom((z) => Math.min(2, z + 0.25))
            }}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      {sided.length > 0 && (
        <div className="siding">
          <span className="eyebrow">Siding</span>
          {sided.map(({ train }) => (
            <button
              key={train.id}
              onClick={() => onSelect({ lineId: train.lineId })}
            >
              {snapshot.lines.find((l) => l.id === train.lineId)?.name} · parked
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
