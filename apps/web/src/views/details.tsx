import type {
  EventEnvelope,
  Line,
  NetworkSnapshot,
  Station,
} from "@terminus/protocol"
import type { ReactNode } from "react"
import { ArrowUpRight, CirclePause, TrainFront } from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { SignalLamp, StatusBadge } from "@/components/status-badge"
import { lineColor } from "@/map/layout"
import type { MapSelection } from "@/map/network-map"
import { api } from "@/state/api"
import { describeEvent, describeLocation, namesFor } from "./describe"
import { TrainPreviewButton } from "./train-preview-button"

type Run = (command: () => Promise<unknown>) => Promise<void>
type Checks = { name: string; status: string; required: boolean }[]

export function LineHeading({
  snapshot,
  line,
  title,
}: {
  snapshot: NetworkSnapshot
  line: Line
  title: string
}) {
  const index = snapshot.lines.indexOf(line)
  return (
    <>
      <span className="drawer-eyebrow">
        <i style={{ background: lineColor(line, index) }}>
          {(index + 1).toString().padStart(2, "0")}
        </i>
        {line.name}
      </span>
      <h2>{title}</h2>
    </>
  )
}

function Section({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function List({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return empty ? <p>{empty}</p> : null
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

function CheckList({ checks }: { checks: Checks }) {
  if (checks.length === 0) return <p>No checks recorded.</p>
  return (
    <ul className="check-list">
      {checks.map((check, i) => (
        <li key={i} className={`check-${check.status}`}>
          <i aria-hidden="true" />
          {check.name}
          <span>
            {check.status}
            {check.required ? "" : " · optional"}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function StationDetails({
  snapshot,
  station,
  onSelect,
}: {
  snapshot: NetworkSnapshot
  station: Station
  onSelect: (selection: MapSelection) => void
}) {
  const name = namesFor(snapshot)
  const { state, manifest } = station
  const car =
    state.status === "complete"
      ? snapshot.cars.find((c) => c.id === state.carId)
      : undefined
  return (
    <>
      <div className="detail-status">
        <StatusBadge status={state.status} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSelect({ lineId: station.lineId })}
        >
          <TrainFront size={15} /> Line Train
        </Button>
      </div>
      <p className="detail-lead">{manifest.goal}</p>

      {(state.status === "signaled" || state.status === "active") && (
        <Section title="Current work">
          <p>
            {state.status === "signaled"
              ? "Signaled. The Station workspace is being prepared."
              : "A Station Agent is working in its isolated workspace."}
          </p>
          {state.workspace && (
            <p>
              Forked from <code>{state.workspace.baseCommit}</code>
            </p>
          )}
        </Section>
      )}
      {(state.status === "ready_for_pickup" ||
        state.status === "in_review") && (
        <Section title="Proposed work">
          <p>
            Candidate <code>{state.proposal.headCommit}</code>
          </p>
          <h4>Changed paths</h4>
          <List items={state.proposal.changedPaths} empty="No changes." />
          <h4>Validation</h4>
          <CheckList checks={state.proposal.evidence.checks} />
          {state.proposal.agentSummary && (
            <>
              <h4>Station Agent summary</h4>
              <p>{state.proposal.agentSummary}</p>
            </>
          )}
        </Section>
      )}
      {state.status === "revising" && (
        <Section title="Conductor feedback">
          <p>{state.feedback.summary}</p>
          <List items={state.feedback.findings} />
        </Section>
      )}
      {state.status === "blocked" && (
        <Section title="Blocked">
          <List items={state.issues.map((issue) => issue.detail)} />
        </Section>
      )}
      {state.status === "cancelled" && (
        <Section title="Cancelled">
          <p>{state.reason}</p>
        </Section>
      )}
      {car && (
        <Section title={`Accepted as Car ${car.position}`}>
          <p>{car.review.summary}</p>
          <List items={car.review.findings} />
          <p>
            Accepted <code>{car.acceptedCommit}</code>
          </p>
          <h4>Changed paths</h4>
          <List items={car.changedPaths} empty="No changes." />
          <h4>Validation</h4>
          <CheckList checks={car.evidence.checks} />
        </Section>
      )}

      <Section title="Work manifest">
        <dl className="detail-grid">
          <div>
            <dt>Scope</dt>
            <dd>
              <List items={manifest.scope} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Acceptance criteria</dt>
            <dd>
              <List items={manifest.acceptanceCriteria} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Expected areas</dt>
            <dd>
              <List items={manifest.expectedAreas} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Areas to avoid</dt>
            <dd>
              <List items={manifest.avoidAreas} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Contracts</dt>
            <dd>
              <List
                items={manifest.contracts.map(
                  (c) =>
                    `${c.name} (${c.kind}, ${c.change.replaceAll("_", " ")})`
                )}
                empty="None declared"
              />
            </dd>
          </div>
          <div>
            <dt>Invariants</dt>
            <dd>
              <List items={manifest.invariants} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Expected evidence</dt>
            <dd>
              <List items={manifest.expectedEvidence} empty="None declared" />
            </dd>
          </div>
          <div>
            <dt>Dependencies</dt>
            <dd>
              <List
                items={manifest.dependencies.map(name)}
                empty="No dependencies"
              />
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="Revisions">
        <p>
          {station.revisionCount === 0
            ? "No revisions requested."
            : `${station.revisionCount} ${station.revisionCount === 1 ? "revision" : "revisions"} requested in total.`}
          {station.retryCount
            ? ` ${station.retryCount} since the last restart.`
            : ""}
        </p>
        {station.lastReview && (
          <details>
            <summary>Latest returned candidate</summary>
            <p>{station.lastReview.feedback.summary}</p>
            <List items={station.lastReview.feedback.findings} />
            <p>
              Candidate <code>{station.lastReview.proposal.headCommit}</code>
            </p>
            <CheckList checks={station.lastReview.proposal.evidence.checks} />
          </details>
        )}
      </Section>
    </>
  )
}

export function TrainDetails({
  snapshot,
  line,
  onSelect,
  pending,
  run,
}: {
  snapshot: NetworkSnapshot
  line: Line
  onSelect: (selection: MapSelection) => void
  pending: boolean
  run: Run
}) {
  const views = snapshot.trains.filter((v) => v.train.lineId === line.id)
  const name = namesFor(snapshot)
  const held = snapshot.holds.some(
    (h) => h.scope.kind === "line" && h.scope.lineId === line.id
  )
  return (
    <>
      {views.length === 0 && (
        <p className="detail-lead">No Train is running on this Line.</p>
      )}
      {views.map(({ train, signal }) => (
        <div key={train.id} className="detail-train">
          <div className="detail-status">
            <StatusBadge status={train.state.status} />
            <span className="detail-signal">
              <SignalLamp signal={signal} />
              {signal ? `Signal ${signal}` : "No current Engineer decision"}
            </span>
          </div>
          <p className="detail-lead">{describeLocation(train.state, name)}</p>
          <TrainPreviewButton trainId={train.id} />
          {train.state.status === "blocked" && (
            <Section title="Blocked">
              <List items={train.state.issues.map((issue) => issue.detail)} />
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => api.clearTrain(train.id))}
              >
                Clear block
              </Button>
            </Section>
          )}
          {train.state.status === "held" && (
            <Section title="Held">
              <List
                items={train.state.reasons.map((r) =>
                  r.kind === "dependency"
                    ? `Waiting for ${name(r.stationId)}`
                    : snapshot.holds.find((h) => h.id === r.holdId)?.note ||
                      r.kind.replaceAll("_", " ")
                )}
              />
            </Section>
          )}
          {train.state.status === "siding" && (
            <Section title="On the siding">
              <p>{train.state.reason}</p>
            </Section>
          )}
          <Section title={`Accepted Cars · ${train.carIds.length}`}>
            {train.carIds.length === 0 && <p>No Cars accepted yet.</p>}
            {snapshot.cars
              .filter((c) => c.trainId === train.id)
              .map((car) => (
                <details key={car.id}>
                  <summary>
                    {car.position}. {name(car.stationId)}
                  </summary>
                  <p>{car.review.summary}</p>
                  <code>{car.acceptedCommit}</code>
                </details>
              ))}
          </Section>
        </div>
      ))}
      <Section title="Station order">
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
                    <StatusBadge status={s.state.status} />
                    <ArrowUpRight size={14} />
                  </button>
                </li>
              )
            )
          })}
          <li className="destination-row">
            <span>T</span> Terminus
          </li>
        </ol>
      </Section>
      <Button
        className="hold-line-button"
        variant="outline"
        size="sm"
        disabled={pending || held}
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
        <CirclePause size={15} /> {held ? "Line held" : "Hold Line"}
      </Button>
      <p className="detail-note">Holds take effect at the next gate.</p>
    </>
  )
}

export function ActivityFeed({
  events,
  snapshot,
}: {
  events: EventEnvelope[]
  snapshot: NetworkSnapshot
}) {
  const name = namesFor(snapshot)
  if (events.length === 0)
    return (
      <p className="detail-lead">
        No events yet. Activity appears here as the network changes.
      </p>
    )
  return (
    <ol className="event-feed">
      {[...events]
        .reverse()
        .slice(0, 100)
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
  )
}
