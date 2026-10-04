import { useRef, useState, type KeyboardEvent } from "react"
import { Minus, Plus, Scan } from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { layoutNetwork, trainPoint } from "./layout"

export type MapSelection = { lineId: string; stationId?: string }
const words = (text: string) => text.replaceAll("_", " ")
function keyboard(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    action()
  }
}
function labelLines(value: string): string[] {
  const words = value.split(/\s+/)
  const lines = [""]
  for (const word of words) {
    if (lines.at(-1)!.length + word.length > 17 && lines.length < 3)
      lines.push(word)
    else lines[lines.length - 1] += `${lines.at(-1) ? " " : ""}${word}`
  }
  return lines.map((line) =>
    line.length > 19 ? `${line.slice(0, 17)}…` : line
  )
}

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
  const { width, height, hub, routes } = layoutNetwork(snapshot.lines)
  const sided = snapshot.trains.filter(
    ({ train }) => train.state.status === "siding"
  )
  return (
    <section className="map-panel" aria-label="Network map">
      <div className="map-caption">
        <span>NETWORK DIAGRAM</span>
        <span>Depot → Stations → Terminus</span>
      </div>
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
            maxHeight: fitted ? 660 : undefined,
          }}
          viewBox={`0 -50 ${width} ${height + 50}`}
          aria-label="Lines run from their depots toward Terminus"
        >
          <title>{snapshot.network.name} railway network</title>
          {routes.map((route) => {
            const { line, color, points, depot } = route
            const selected = selection?.lineId === line.id
            const views = snapshot.trains.filter(
              ({ train }) => train.lineId === line.id
            )
            const path = points
              .map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`)
              .join(" ")
            return (
              <g key={line.id}>
                <path d={path} className="track-underlay" />
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={selected ? 9 : 7}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${line.name}`}
                  onClick={() => onSelect({ lineId: line.id })}
                  onKeyDown={(e) =>
                    keyboard(e, () => onSelect({ lineId: line.id }))
                  }
                  className="map-target"
                >
                  <rect
                    x={depot.x - 90}
                    y={depot.y - 110}
                    width="180"
                    height="150"
                    fill="transparent"
                  />
                  <title>
                    {line.name} · {route.shape} route
                  </title>
                  <rect
                    x={depot.x - 22}
                    y={depot.y - 76}
                    width="44"
                    height="32"
                    rx="16"
                    fill={color}
                  />
                  <text x={depot.x} y={depot.y - 54} className="route-number">
                    {route.number.toString().padStart(2, "0")}
                  </text>
                  <text
                    x={depot.x}
                    y={depot.y - 90}
                    textAnchor="middle"
                    className="route-name"
                  >
                    {line.name.length > 24
                      ? `${line.name.slice(0, 22)}…`
                      : line.name}
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
                  <text
                    x={depot.x}
                    y={depot.y + 31}
                    textAnchor="middle"
                    className="map-secondary"
                  >
                    DEPOT
                  </text>
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
                  const label = labelLines(station.name)
                  const labelOffset =
                    route.shape === "sweep" && i === 0 ? 97 : i % 2 ? 85 : 57
                  return (
                    <g
                      key={id}
                      role="button"
                      tabIndex={0}
                      className="map-target"
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
                        x={p.x - 65}
                        y={p.y - 125}
                        width="130"
                        height="175"
                        fill="transparent"
                      />
                      <title>
                        {station.name} · {words(status)}
                      </title>
                      <circle cx={p.x} cy={p.y} r="22" fill="transparent" />
                      {(active || chosen) && (
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="15"
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
                        stroke={status === "blocked" ? "#bc3042" : color}
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
                        y={p.y - labelOffset - (label.length - 1) * 20}
                        textAnchor="middle"
                        className="station-label"
                      >
                        {label.map((text, j) => (
                          <tspan key={j} x={p.x} dy={j === 0 ? 0 : 20}>
                            {text}
                          </tspan>
                        ))}
                      </text>
                      <text
                        x={p.x}
                        y={p.y + 34}
                        textAnchor="middle"
                        className={`station-state ${status === "blocked" ? "state-blocked" : ""}`}
                      >
                        {words(status)}
                      </text>
                    </g>
                  )
                })}
                {views.map((view) => {
                  const p = trainPoint(view.train.state, route, hub)
                  if (!p) return null
                  const status = view.train.state.status
                  return (
                    <g
                      key={view.train.id}
                      className={`map-target train-marker train-${status}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${line.name} Train, ${words(status)}, signal ${view.signal ?? "not available"}`}
                      onClick={() => onSelect({ lineId: line.id })}
                      onKeyDown={(e) =>
                        keyboard(e, () => onSelect({ lineId: line.id }))
                      }
                    >
                      <rect
                        className="train-hitbox"
                        x={p.x - 61}
                        y={p.y + 6}
                        width="122"
                        height="75"
                        fill="transparent"
                      />
                      <title>
                        Train · {words(status)} · {view.train.carIds.length}{" "}
                        Cars
                      </title>
                      <path
                        d={`M${p.x},${p.y + 7} v42`}
                        className="train-leader"
                      />
                      <rect
                        x={p.x - 59}
                        y={p.y + 48}
                        width="118"
                        height="30"
                        rx="5"
                        fill={
                          status === "blocked"
                            ? "#a82538"
                            : status === "held"
                              ? "#805510"
                              : "var(--map-ink)"
                        }
                      />
                      <g
                        transform={`translate(${p.x - 49},${p.y + 55})`}
                        fill="none"
                        stroke="white"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <rect width="12" height="12" rx="2" />
                        <path d="M2 3h8v4H2z M2 15l2-3 M8 12l2 3" />
                      </g>
                      <text x={p.x + 3} y={p.y + 66} className="train-label">
                        {words(status)}
                      </text>
                      {view.signal && (
                        <circle
                          cx={p.x + 49}
                          cy={p.y + 63}
                          r="4"
                          fill={view.signal === "green" ? "#7ce0ae" : "#ff8c93"}
                        />
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
          <g className="terminus-hub">
            <circle
              cx={hub.x}
              cy={hub.y}
              r="43"
              fill="var(--map-paper)"
              stroke="var(--map-ink)"
              strokeWidth="4"
            />
            <circle cx={hub.x} cy={hub.y} r="33" fill="var(--map-ink)" />
            <text x={hub.x} y={hub.y + 10} className="hub-letter">
              T
            </text>
            <text
              x={hub.x}
              y={hub.y + 75}
              textAnchor="middle"
              className="hub-title"
            >
              Terminus
            </text>
            <text
              x={hub.x}
              y={hub.y + 97}
              textAnchor="middle"
              className="map-secondary"
            >
              CANONICAL PROJECT STATE
            </text>
          </g>
        </svg>
      </div>
      <p className="map-navigation-hint">
        {fitted
          ? "Whole network · zoom in to read Stations"
          : "Scroll or swipe to explore · Fit network to see all Lines"}
      </p>
      <div className="map-bottom">
        <div className="map-key">
          <span>
            <i className="key-depot" /> Depot
          </span>
          <span>
            <i className="key-station" /> Station
          </span>
          <span>
            <i className="key-complete" /> Accepted
          </span>
          <span>
            <i className="key-train" /> Train
          </span>
          <span>
            <i className="key-signal" /> Red signal: stop
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
          >
            <Scan size={15} />
            <span>Fit network</span>
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
