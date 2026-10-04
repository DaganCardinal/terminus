import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import { useState } from "react"
import {
  ArrowLeft,
  ArrowUpRight,
  CirclePause,
  GitCommitHorizontal,
  Map,
  Radio,
  Route,
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
  return (
    <div className="network-workspace">
      <header className="network-header">
        <div>
          <a className="back-link" href="#/">
            <ArrowLeft size={14} /> All networks
          </a>
          <h1>{snapshot.network.name}</h1>
          <p>Follow the work. See what’s moving.</p>
        </div>
        <div className="sync-state">
          <i className={error ? "sync-error" : ""} />
          {error ? "Connection interrupted" : "Polling network"}
          <span>#{snapshot.lastSeq}</span>
        </div>
      </header>
      {(error || commandError) && (
        <div className="network-alert" role="alert">
          {commandError ??
            `${error} · Showing the last received state; reconnecting automatically.`}
        </div>
      )}
      <div className="network-toolbar">
        <div className="active-map-tab">
          <Map size={16} /> Network map
        </div>
        <div className="network-counts">
          <span>
            <b>{snapshot.lines.length}</b> Lines
          </span>
          <span>
            <b>{running.length}</b> Trains on network
          </span>
          <span>
            <b>{snapshot.cars.length}</b> Cars accepted
          </span>
          {held > 0 && (
            <span className="attention-count">
              <b>{held}</b> held
            </span>
          )}
          {blocked > 0 && (
            <span className="blocked-count">
              <b>{blocked}</b> blocked
            </span>
          )}
        </div>
      </div>
      {snapshot.lines.length === 0 ? (
        <section className="network-empty">
          <Route size={44} />
          <h2>Your network starts here</h2>
          <p>
            Lay the demo Lines to send two Trains from their depots toward
            Terminus.
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
        <div className="network-grid">
          <aside className="line-directory">
            <div className="panel-heading">
              <h2>Lines</h2>
              <span>
                {snapshot.lines.length.toString().padStart(2, "0")}
                <span className="mobile-lines-hint"> · Swipe to browse →</span>
              </span>
            </div>
            <p className="directory-hint">
              Select a Line to inspect its journey.
            </p>
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
                    onClick={() => setSelection({ lineId: line.id })}
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
                        {complete} / {line.stationIds.length} Stations complete
                      </span>
                      {train && <StatusBadge status={train.state.status} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="directory-footer">
              <Route size={17} />
              <p>
                All Lines lead to Terminus.
                <br />
                Only accepted work travels onward.
              </p>
            </div>
          </aside>
          <NetworkMap
            snapshot={snapshot}
            selection={selection}
            onSelect={setSelection}
          />
          <aside className="network-inspector">
            {selection ? (
              <Inspector
                snapshot={snapshot}
                selection={selection}
                onSelect={setSelection}
                onClose={() => setSelection(null)}
                pending={pending}
                run={run}
              />
            ) : (
              <>
                <div className="panel-heading">
                  <h2>Network overview</h2>
                  <Radio size={16} />
                </div>
                <div className="overview-body">
                  <div className="overview-terminus">T</div>
                  <h3>
                    One destination.
                    <br />
                    Many workstreams.
                  </h3>
                  <p>
                    Select a Station or Line on the map to see its manifest,
                    Train, and accepted work.
                  </p>
                  <div className="overview-stat">
                    <span>Stations complete</span>
                    <strong>
                      {
                        snapshot.stations.filter(
                          (s) => s.state.status === "complete"
                        ).length
                      }{" "}
                      / {snapshot.stations.length}
                    </strong>
                  </div>
                  <div className="overview-stat">
                    <span>Active holds</span>
                    <strong>{snapshot.holds.length}</strong>
                  </div>
                  <div className="overview-stat">
                    <span>Unresolved conflicts</span>
                    <strong>
                      {
                        snapshot.conflicts.filter((c) => c.status === "open")
                          .length
                      }
                    </strong>
                  </div>
                  <div className="commit-note">
                    <GitCommitHorizontal size={16} />
                    <span>
                      Terminus commit
                      <code>{snapshot.network.terminusCommit}</code>
                    </span>
                  </div>
                </div>
              </>
            )}
          </aside>
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
        <h2>{station ? "Station details" : "Line details"}</h2>
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
            <p className="revision-note">{station.revisionCount} revisions</p>
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
              Engineer signal:{" "}
              <strong>{signal ?? "No current decision"}</strong>
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
    <section className="event-feed">
      <div className="panel-heading">
        <h2>
          <Radio size={15} /> Network activity
        </h2>
        <span>Domain event history</span>
      </div>
      {events.length === 0 ? (
        <p className="activity-empty">
          No events yet. Activity will appear as the network changes.
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
                <span className="event-dot" />
                <span>{describeEvent(envelope.event, name)}</span>
                <code>#{envelope.seq}</code>
              </li>
            ))}
        </ol>
      )}
    </section>
  )
}
