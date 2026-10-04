import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import { useState } from "react"
import {
  ArrowLeft,
  ArrowUpRight,
  CirclePause,
  Radio,
  TrainFront,
  X,
} from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { StatusBadge, SignalLamp } from "@/components/status-badge"
import { NetworkMap, type MapSelection } from "@/map/network-map"
import { lineColor } from "@/map/layout"
import { api } from "@/state/api"
import { useNetwork } from "@/state/use-network"
import { describeEvent, describeLocation, namesFor } from "./describe"
import { DispatcherPanel } from "./dispatcher-panel"

export function NetworkStatus({ networkId }: { networkId: string }) {
  const { snapshot, events, error } = useNetwork(networkId)
  const [selection, setSelection] = useState<MapSelection | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
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
  const running = snapshot.trains.filter(
    ({ train }) => !["unloaded", "siding"].includes(train.state.status)
  )
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
  return (
    <div className="network-workspace">
      <header className="network-header">
        <div>
          <a className="back-link" href="#/">
            <ArrowLeft size={14} /> All networks
          </a>
          <div className="network-title">
            <h1>{snapshot.network.name}</h1>
            <span className="sync-state" role="status">
              <i className={error ? "sync-error" : ""} />
              {error ? "Reconnecting" : "Live"} · event {snapshot.lastSeq}
            </span>
            <span className="terminus-commit">
              Terminus{" "}
              <code title={snapshot.network.terminusCommit}>
                {snapshot.network.terminusCommit.slice(0, 12)}
              </code>
            </span>
          </div>
        </div>
        <dl className="network-stats">
          <div>
            <dt>Lines</dt>
            <dd>{snapshot.lines.length}</dd>
          </div>
          <div>
            <dt>Trains running</dt>
            <dd>{running.length}</dd>
          </div>
          <div>
            <dt>Stations accepted</dt>
            <dd>
              {stationsComplete}
              <span> / {snapshot.stations.length}</span>
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
      {(error || commandError) && (
        <div className="network-alert" role="alert">
          {commandError ??
            `${error} · Showing the last received state; reconnecting automatically.`}
        </div>
      )}
      <DispatcherPanel snapshot={snapshot} />
      {snapshot.lines.length === 0 ? (
        <section className="network-empty panel">
          <EmptyNetworkArt />
          <h2>No Lines on this network yet</h2>
          <p>
            Describe a goal to the Dispatcher above and review its plan, or lay
            the fixed demo Lines to explore the railway.
          </p>
          <Button
            disabled={pending}
            onClick={() => run(() => api.layDemoLines(networkId))}
          >
            {pending ? "Laying Lines…" : "Lay demo Lines"}
            <ArrowUpRight size={16} />
          </Button>
        </section>
      ) : (
        <div
          className={`network-grid panel ${selection ? "has-inspector" : ""}`}
        >
          <aside className="line-directory" aria-label="Lines">
            <div className="panel-heading">
              <h2>Lines</h2>
              <span>
                {snapshot.lines.length}
                <span className="mobile-lines-hint"> · swipe to browse</span>
              </span>
            </div>
            <div className="line-list">
              {snapshot.lines.map((line, index) => {
                const train = snapshot.trains.find(
                  (v) => v.train.lineId === line.id
                )?.train
                const complete = line.stationIds.filter(
                  (id) =>
                    snapshot.stations.find((s) => s.id === id)?.state.status ===
                    "complete"
                ).length
                return (
                  <button
                    key={line.id}
                    className={`line-link ${selection?.lineId === line.id ? "selected" : ""}`}
                    aria-pressed={selection?.lineId === line.id}
                    onClick={() =>
                      setSelection(
                        selection?.lineId === line.id && !selection.stationId
                          ? null
                          : { lineId: line.id }
                      )
                    }
                  >
                    <span
                      className="line-bullet"
                      style={{ background: lineColor(line, index) }}
                    >
                      {(index + 1).toString().padStart(2, "0")}
                    </span>
                    <span className="line-link-copy">
                      <strong>{line.name}</strong>
                      <span>
                        {complete} of {line.stationIds.length} Stations accepted
                      </span>
                      {train && <StatusBadge status={train.state.status} />}
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>
          <NetworkMap
            snapshot={snapshot}
            selection={selection}
            onSelect={setSelection}
          />
          {selection && (
            <aside className="network-inspector" aria-label="Details">
              <Inspector
                snapshot={snapshot}
                selection={selection}
                onSelect={setSelection}
                onClose={() => setSelection(null)}
                pending={pending}
                run={run}
              />
            </aside>
          )}
        </div>
      )}
      {snapshot.holds.length > 0 && (
        <section className="hold-strip" aria-label="Active holds">
          <CirclePause size={18} />
          <strong>Active holds</strong>
          {snapshot.holds.map((hold) => (
            <div key={hold.id}>
              <span>{hold.note || hold.kind}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => api.releaseHold(networkId, hold.id))}
              >
                Release hold
              </Button>
            </div>
          ))}
        </section>
      )}
      <EventFeed events={events} snapshot={snapshot} />
    </div>
  )
}

function Inspector({
  snapshot,
  selection,
  onSelect,
  onClose,
  pending,
  run,
}: {
  snapshot: NetworkSnapshot
  selection: MapSelection
  onSelect: (s: MapSelection) => void
  onClose: () => void
  pending: boolean
  run: (command: () => Promise<unknown>) => Promise<void>
}) {
  const line = snapshot.lines.find((l) => l.id === selection.lineId)
  if (!line)
    return <p className="overview-body">This Line is no longer available.</p>
  const station = snapshot.stations.find((s) => s.id === selection.stationId)
  const views = snapshot.trains.filter((v) => v.train.lineId === line.id)
  const name = namesFor(snapshot)
  return (
    <>
      <div className="panel-heading">
        <h2>{station ? "Station" : "Line"}</h2>
        <button onClick={onClose} aria-label="Close details">
          <X size={17} />
        </button>
      </div>
      <div className="inspector-body">
        <span className="eyebrow">{line.name}</span>
        <h3>{station?.name ?? "Journey to Terminus"}</h3>
        {station && (
          <>
            <StatusBadge status={station.state.status} />
            <h4>Work manifest</h4>
            <p>{station.manifest.goal}</p>
            {station.manifest.acceptanceCriteria.length > 0 && (
              <>
                <h4>Acceptance criteria</h4>
                <ul>
                  {station.manifest.acceptanceCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            {station.manifest.dependencies.length > 0 && (
              <>
                <h4>Dependencies</h4>
                <p>{station.manifest.dependencies.map(name).join(", ")}</p>
              </>
            )}
            <p className="revision-note">
              {station.revisionCount === 0
                ? "No revisions requested"
                : `${station.revisionCount} ${station.revisionCount === 1 ? "revision" : "revisions"} requested`}
            </p>
          </>
        )}
        {views.map(({ train, signal }) => (
          <section key={train.id} className="inspector-train">
            <h4>
              <TrainFront size={15} /> Train <SignalLamp signal={signal} />
            </h4>
            <StatusBadge status={train.state.status} />
            <p>{describeLocation(train.state, name)}</p>
            <p>
              {signal ? (
                <>
                  Engineer signal is <strong>{signal}</strong>
                </>
              ) : (
                "No current Engineer decision"
              )}
            </p>
            {train.state.status === "blocked" && (
              <>
                <ul className="issue-list">
                  {train.state.issues.map((issue, i) => (
                    <li key={i}>{issue.detail}</li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => api.clearTrain(train.id))}
                >
                  Clear block
                </Button>
              </>
            )}
            {train.state.status === "held" && (
              <ul className="issue-list">
                {train.state.reasons.map((r, i) => (
                  <li key={i}>
                    {r.kind === "dependency"
                      ? `Waiting for ${name(r.stationId)}`
                      : snapshot.holds.find((h) => h.id === r.holdId)?.note ||
                        r.kind.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            )}
            {train.state.status === "siding" && <p>{train.state.reason}</p>}
            <h4>Accepted Cars · {train.carIds.length}</h4>
            {snapshot.cars
              .filter((c) => c.trainId === train.id)
              .map((car) => (
                <details key={car.id}>
                  <summary>{name(car.stationId)}</summary>
                  <p>{car.review.summary}</p>
                  <code>{car.acceptedCommit}</code>
                </details>
              ))}
          </section>
        ))}
        <h4>Station order</h4>
        <ol className="station-order">
          {line.stationIds.map((id, i) => {
            const s = snapshot.stations.find((s) => s.id === id)
            return (
              s && (
                <li key={id}>
                  <button
                    onClick={() => onSelect({ lineId: line.id, stationId: id })}
                  >
                    <span>{i + 1}</span>
                    {s.name}
                  </button>
                </li>
              )
            )
          })}
          <li className="destination-row">
            T <span>Terminus</span>
          </li>
        </ol>
        <Button
          className="hold-line-button"
          variant="outline"
          size="sm"
          disabled={
            pending ||
            snapshot.holds.some(
              (h) => h.scope.kind === "line" && h.scope.lineId === line.id
            )
          }
          onClick={() =>
            run(() =>
              api.placeHold(snapshot.network.id, {
                kind: "user",
                scope: { kind: "line", lineId: line.id },
                note: `Hold on ${line.name}`,
              })
            )
          }
        >
          <CirclePause size={15} /> Hold Line
        </Button>
        <p className="revision-note">Holds take effect at the next gate.</p>
      </div>
    </>
  )
}

function EventFeed({
  events,
  snapshot,
}: {
  events: EventEnvelope[]
  snapshot: NetworkSnapshot
}) {
  const name = namesFor(snapshot)
  return (
    <section className="event-feed panel" aria-label="Network activity">
      <div className="panel-heading">
        <h2>
          <Radio size={15} /> Activity
        </h2>
        <span>Newest first</span>
      </div>
      {events.length === 0 ? (
        <p className="activity-empty">
          No events yet. Activity appears here as the network changes.
        </p>
      ) : (
        <ol>
          {[...events]
            .reverse()
            .slice(0, 60)
            .map((envelope) => (
              <li key={envelope.seq}>
                <time dateTime={envelope.occurredAt}>
                  {new Date(envelope.occurredAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <span>{describeEvent(envelope.event, name)}</span>
                <code>#{envelope.seq}</code>
              </li>
            ))}
        </ol>
      )}
    </section>
  )
}

/** Decorative first-run illustration: two Lines curving into Terminus. */
function EmptyNetworkArt() {
  return (
    <svg
      className="network-empty-art"
      viewBox="0 0 220 96"
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
    >
      <path
        d="M12 26 H70 A24 24 0 0 1 87 33 L104 50 A10 10 0 0 0 111 53 H110"
        stroke="#ce3548"
        strokeWidth="6"
      />
      <path
        d="M12 80 H70 A24 24 0 0 0 87 73 L104 56 A10 10 0 0 1 111 53"
        stroke="#176ab5"
        strokeWidth="6"
      />
      <path
        d="M208 53 H110"
        stroke="#008477"
        strokeWidth="6"
        strokeDasharray="1 12"
      />
      <circle
        cx="40"
        cy="26"
        r="5"
        fill="var(--map-paper)"
        stroke="#ce3548"
        strokeWidth="3"
      />
      <circle
        cx="40"
        cy="80"
        r="5"
        fill="var(--map-paper)"
        stroke="#176ab5"
        strokeWidth="3"
      />
      <circle
        cx="122"
        cy="53"
        r="22"
        fill="var(--map-paper)"
        stroke="var(--map-ink)"
        strokeWidth="3"
      />
      <circle cx="122" cy="53" r="15" fill="var(--map-ink)" />
      <text
        x="122"
        y="59"
        textAnchor="middle"
        fontSize="16"
        fontWeight="700"
        fill="var(--map-paper)"
      >
        T
      </text>
    </svg>
  )
}
