import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { ArrowLeft, CirclePause, Radio } from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { Drawer } from "@/components/drawer"
import { AppMenu } from "@/components/app-menu"
import { MOBILE_QUERY, useMediaQuery } from "@/components/use-media-query"
import {
  NetworkMap,
  type MapInsets,
  type MapSelection,
} from "@/map/network-map"
import { api } from "@/state/api"
import { routes } from "@/state/route"
import { useNetwork } from "@/state/use-network"
import {
  ActivityFeed,
  LineHeading,
  StationDetails,
  TrainDetails,
} from "./details"
import { DispatcherButton, DispatcherPanel } from "./dispatcher"
import { TerminusDetails } from "./terminus-details"

type Panel =
  | { kind: "station"; lineId: string; stationId: string }
  | { kind: "train"; lineId: string }
  | { kind: "activity" }
  | { kind: "terminus" }

const DRAWER_WIDTH = 480
const GUTTER = 24
/** Wide enough for the Dispatcher, a drawer and some map side by side. */
const ROOMY_QUERY = "(min-width: 1180px)"

/** The network map is the whole page; everything else floats over it. */
export function NetworkStatus({ networkId }: { networkId: string }) {
  const { snapshot, events, error } = useNetwork(networkId)
  const mobile = useMediaQuery(MOBILE_QUERY)
  const roomy = useMediaQuery(ROOMY_QUERY)
  const [panel, setPanelState] = useState<Panel | null>(null)
  const [expanded, setExpanded] = useState(false)
  // Until the user chooses, the Dispatcher opens for an empty network.
  const [dispatcherChoice, setDispatcherOpen] = useState<boolean | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [dispatcherWidth, setDispatcherWidth] = useState(0)
  const dispatcherButton = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [headerHeight, setHeaderHeight] = useState(0)
  const header = useCallback((element: HTMLElement | null) => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeaderHeight(entry.borderBoxSize[0]?.blockSize ?? 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const closePanel = useCallback(() => setPanelState(null), [])
  // Without room for both, the Dispatcher and a drawer take turns.
  const setPanel = (next: Panel | null) => {
    setPanelState(next)
    if (next && !roomy) setDispatcherOpen(false)
  }

  async function run(command: () => Promise<unknown>) {
    setPending(true)
    setCommandError(null)
    try {
      await command()
    } catch (caught) {
      setCommandError(String(caught))
    } finally {
      setPending(false)
    }
  }

  if (!snapshot)
    return (
      <div className="network-loading" role="status">
        {error
          ? `Unable to load network: ${error}. Retrying…`
          : "Loading your network…"}
      </div>
    )

  const select = (selection: MapSelection) =>
    setPanel(
      selection.stationId
        ? {
            kind: "station",
            lineId: selection.lineId,
            stationId: selection.stationId,
          }
        : { kind: "train", lineId: selection.lineId }
    )
  const selection: MapSelection | null =
    panel?.kind === "station"
      ? { lineId: panel.lineId, stationId: panel.stationId }
      : panel?.kind === "train"
        ? { lineId: panel.lineId }
        : null
  const dispatcherOpen = dispatcherChoice ?? snapshot.lines.length === 0
  const drawerBesideMap = panel !== null && !mobile && !expanded
  const dispatcherBesideMap = dispatcherOpen && !mobile
  const insets: MapInsets = {
    top: GUTTER + headerHeight + (mobile ? 8 : 16),
    right:
      GUTTER +
      (drawerBesideMap ? DRAWER_WIDTH : 0) +
      (dispatcherBesideMap ? dispatcherWidth + 12 : 0),
    bottom: mobile ? 84 : 96,
    left: GUTTER,
  }

  const running = snapshot.trains.filter(
    ({ train }) => !["unloaded", "siding"].includes(train.state.status)
  ).length
  const held = snapshot.trains.filter(
    ({ train }) => train.state.status === "held"
  ).length
  const blocked = snapshot.trains.filter(
    ({ train }) => train.state.status === "blocked"
  ).length
  const stationsComplete = snapshot.stations.filter(
    (s) => s.state.status === "complete"
  ).length
  const openConflicts = snapshot.conflicts.filter(
    (c) => c.status === "open"
  ).length

  const line =
    panel && (panel.kind === "train" || panel.kind === "station")
      ? snapshot.lines.find((l) => l.id === panel.lineId)
      : undefined
  const station =
    panel?.kind === "station"
      ? snapshot.stations.find((s) => s.id === panel.stationId)
      : undefined

  return (
    <div
      className={`network-workspace ${drawerBesideMap ? "drawer-open" : ""}`}
      style={
        {
          "--dispatcher-space": dispatcherBesideMap
            ? `${dispatcherWidth + 12}px`
            : "0px",
        } as CSSProperties
      }
    >
      <NetworkMap
        snapshot={snapshot}
        selection={selection}
        terminusSelected={panel?.kind === "terminus"}
        onSelectTerminus={() => setPanel({ kind: "terminus" })}
        onSelect={select}
        onClear={closePanel}
        insets={insets}
        compactKey={mobile}
      />
      <div className="map-topfade" aria-hidden="true" />

      <header ref={header} className="network-header">
        <a className="back-link glass" href={routes.overview(networkId)}>
          <ArrowLeft size={14} /> Overview
        </a>
        <div className="network-title">
          <h1>{snapshot.network.name}</h1>
          <span className="sync-state" role="status">
            <i className={error ? "sync-error" : ""} />
            {error ? "Reconnecting" : "Live"}
          </span>
        </div>
        <dl className="network-stats">
          <div>
            <dt>Lines</dt>
            <dd>{snapshot.lines.length}</dd>
          </div>
          <div>
            <dt>Trains running</dt>
            <dd>{running}</dd>
          </div>
          <div>
            <dt>Stations accepted</dt>
            <dd>
              {stationsComplete}
              <span>/{snapshot.stations.length}</span>
            </dd>
          </div>
          <div>
            <dt>Cars accepted</dt>
            <dd>{snapshot.cars.length}</dd>
          </div>
          {held > 0 && (
            <div className="stat-held">
              <dt>Held</dt>
              <dd>{held}</dd>
            </div>
          )}
          {blocked > 0 && (
            <div className="stat-blocked">
              <dt>Blocked</dt>
              <dd>{blocked}</dd>
            </div>
          )}
          {openConflicts > 0 && (
            <div className="stat-blocked">
              <dt>Open conflicts</dt>
              <dd>{openConflicts}</dd>
            </div>
          )}
        </dl>
      </header>

      <div className="map-overlay map-overlay-top-right">
        {snapshot.holds.length > 0 && (
          <HoldsMenu
            holds={snapshot.holds}
            pending={pending}
            release={(holdId) => run(() => api.releaseHold(networkId, holdId))}
          />
        )}
        <button
          className="overlay-button glass"
          aria-pressed={panel?.kind === "activity"}
          onClick={() =>
            setPanel(panel?.kind === "activity" ? null : { kind: "activity" })
          }
        >
          <Radio size={16} />
          <span className="overlay-button-label">Activity</span>
        </button>
        <AppMenu
          variant="map"
          settingsHref={routes.networkSettings(networkId)}
        />
      </div>

      {(error || commandError) && (
        <div className="network-alert glass" role="alert">
          {commandError ??
            `${error} · Showing the last received state; reconnecting automatically.`}
        </div>
      )}

      {panel && (
        <Drawer
          label={
            panel.kind === "activity"
              ? "Network activity"
              : panel.kind === "terminus"
                ? "Terminus details"
                : station
                  ? `Station ${station.name}`
                  : `Train on ${line?.name ?? "this Line"}`
          }
          heading={
            panel.kind === "activity" ? (
              <>
                <span className="drawer-eyebrow">Newest first</span>
                <h2>Activity</h2>
              </>
            ) : panel.kind === "terminus" ? (
              <>
                <span className="drawer-eyebrow">Canonical project state</span>
                <h2>Terminus</h2>
              </>
            ) : line ? (
              <LineHeading
                snapshot={snapshot}
                line={line}
                title={station?.name ?? "Train"}
              />
            ) : (
              <h2>Unavailable</h2>
            )
          }
          expanded={expanded}
          onExpandedChange={setExpanded}
          onClose={closePanel}
        >
          {panel.kind === "activity" ? (
            <ActivityFeed events={events} snapshot={snapshot} />
          ) : panel.kind === "terminus" ? (
            <TerminusDetails
              snapshot={snapshot}
              openTrain={(lineId) => setPanel({ kind: "train", lineId })}
            />
          ) : !line || (panel.kind === "station" && !station) ? (
            <p className="detail-lead">This item is no longer on the map.</p>
          ) : station ? (
            <StationDetails
              key={station.id}
              snapshot={snapshot}
              station={station}
              onSelect={select}
              pending={pending}
              run={run}
            />
          ) : (
            <TrainDetails
              snapshot={snapshot}
              line={line}
              onSelect={select}
              pending={pending}
              run={run}
            />
          )}
        </Drawer>
      )}

      <DispatcherButton
        ref={dispatcherButton}
        snapshot={snapshot}
        hidden={dispatcherOpen}
        onOpen={() => {
          setDispatcherOpen(true)
          if (!roomy) setPanelState(null)
        }}
      />
      <DispatcherPanel
        snapshot={snapshot}
        open={dispatcherOpen}
        mobile={mobile}
        onClose={() => {
          setDispatcherOpen(false)
          requestAnimationFrame(() => dispatcherButton.current?.focus())
        }}
        onResize={setDispatcherWidth}
        openTrain={(lineId) => setPanel({ kind: "train", lineId })}
      />
    </div>
  )
}

function HoldsMenu({
  holds,
  pending,
  release,
}: {
  holds: NetworkSnapshot["holds"]
  pending: boolean
  release: (holdId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="holds">
      <button
        className="overlay-button glass holds-chip"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CirclePause size={16} />
        {holds.length} {holds.length === 1 ? "hold" : "holds"}
      </button>
      {open && (
        <div className="holds-popover glass" aria-label="Active holds">
          <h2>Active holds</h2>
          <ul>
            {holds.map((hold) => (
              <li key={hold.id}>
                <span>{hold.note || hold.kind}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void release(hold.id)}
                >
                  Release
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
