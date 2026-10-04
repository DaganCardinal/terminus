import type {
  Car,
  EventEnvelope,
  Line,
  NetworkSnapshot,
  Station,
} from "@terminus/protocol"
import type { CSSProperties, ReactNode } from "react"
import { useId, useState } from "react"
import {
  ArrowUpRight,
  Ban,
  CircleCheck,
  CirclePause,
  ClipboardCheck,
  LoaderCircle,
  OctagonAlert,
  RotateCcw,
  TrainFront,
} from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { StatusBadge } from "@/components/status-badge"
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

/** The one thing to read first: what is happening at this Station now. */
function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "working" | "review" | "held" | "attention" | "done" | "idle"
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className={`detail-callout callout-${tone}`}>
      <h3>
        {icon}
        {title}
      </h3>
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

/** Short identifiers as chips; paths and symbols set in monospace. */
function Tags({ items }: { items: string[] }) {
  return (
    <ul className="detail-tags">
      {items.map((item, i) => (
        <li key={i} className={/\s/.test(item) ? undefined : "tag-code"}>
          {item}
        </li>
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

function Manifest({
  manifest,
  name,
}: {
  manifest: Station["manifest"]
  name: (id: string) => string
}) {
  const fields: { label: string; items: string[]; tags?: boolean }[] = [
    {
      label: "Repository change",
      items: manifest.repositoryChange
        ? [
            `${manifest.repositoryChange.kind}: ${manifest.repositoryChange.description}`,
          ]
        : [],
    },
    { label: "Acceptance criteria", items: manifest.acceptanceCriteria },
    { label: "Invariants", items: manifest.invariants },
    { label: "Scope", items: manifest.scope, tags: true },
    { label: "Expected areas", items: manifest.expectedAreas, tags: true },
    { label: "Areas to avoid", items: manifest.avoidAreas, tags: true },
    {
      label: "Contracts",
      items: manifest.contracts.map(
        (c) => `${c.name} · ${c.kind}, ${c.change.replaceAll("_", " ")}`
      ),
      tags: true,
    },
    {
      label: "Expected evidence",
      items: manifest.expectedEvidence,
      tags: true,
    },
    {
      label: "Dependencies",
      items: manifest.dependencies.map(name),
      tags: true,
    },
  ]
  const declared = fields.filter((f) => f.items.length > 0)
  const undeclared = fields.filter((f) => f.items.length === 0)
  return (
    <Section title="Work manifest">
      <dl className="detail-grid">
        {declared.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>
              {field.tags ? (
                <Tags items={field.items} />
              ) : (
                <List items={field.items} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {undeclared.length > 0 && (
        <p className="detail-note">
          Not declared: {undeclared.map((f) => f.label).join(", ")}
        </p>
      )}
    </Section>
  )
}

export function StationDetails({
  snapshot,
  station,
  onSelect,
  pending,
  run,
}: {
  snapshot: NetworkSnapshot
  station: Station
  onSelect: (selection: MapSelection) => void
  pending: boolean
  run: Run
}) {
  const [reason, setReason] = useState("")
  const reasonId = useId()
  const name = namesFor(snapshot)
  const { state, manifest } = station
  const car =
    state.status === "complete"
      ? snapshot.cars.find((c) => c.id === state.carId)
      : undefined
  return (
    <>
      <div className="detail-status">
        <StatusBadge status={state.status} dot />
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
        <Callout
          tone="working"
          icon={<LoaderCircle className="animate-spin" size={15} />}
          title={
            state.status === "signaled" ? "Preparing workspace" : "Working"
          }
        >
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
        </Callout>
      )}
      {(state.status === "ready_for_pickup" ||
        state.status === "in_review") && (
        <Callout
          tone="review"
          icon={<ClipboardCheck size={15} />}
          title={
            state.status === "in_review"
              ? "Conductor reviewing"
              : "Ready for pickup"
          }
        >
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
        </Callout>
      )}
      {state.status === "revising" && (
        <Callout
          tone="review"
          icon={<RotateCcw size={15} />}
          title="Returned for revision"
        >
          <p className="callout-lead">{state.feedback.summary}</p>
          <List items={state.feedback.findings} />
          {station.lastReview && (
            <p>
              Returned candidate{" "}
              <code>{station.lastReview.proposal.headCommit}</code>
            </p>
          )}
        </Callout>
      )}
      {state.status === "blocked" && (
        <Callout
          tone="attention"
          icon={<OctagonAlert size={15} />}
          title="Blocked"
        >
          <List items={state.issues.map((issue) => issue.detail)} />
        </Callout>
      )}
      {state.status === "cancelled" && (
        <Callout tone="idle" icon={<Ban size={15} />} title="Cancelled">
          <p>{state.reason}</p>
        </Callout>
      )}
      {car && (
        <Callout
          tone="done"
          icon={<CircleCheck size={15} />}
          title={`Accepted as Car ${car.position}`}
        >
          <p className="callout-lead">{car.review.summary}</p>
          <List items={car.review.findings} />
          <p>
            Accepted <code>{car.acceptedCommit}</code>
          </p>
          <h4>Changed paths</h4>
          <List items={car.changedPaths} empty="No changes." />
          <h4>Validation</h4>
          <CheckList checks={car.evidence.checks} />
        </Callout>
      )}

      <Manifest manifest={manifest} name={name} />

      {(state.status === "waiting" || state.status === "blocked") && (
        <Section title="Remove Station">
          <p>
            The Train will skip this Station. Its history stays inspectable.
            Removal is refused while unfinished Stations depend on it.
          </p>
          {station.removalRequest ? (
            <p>Removal requested. Waiting for the Train to apply it.</p>
          ) : (
            <form
              className="dispatcher-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (reason.trim())
                  void run(() =>
                    api.removeStation(
                      snapshot.network.id,
                      station.id,
                      reason.trim()
                    )
                  )
              }}
            >
              <label htmlFor={reasonId}>Reason</label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={2000}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={pending}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !reason.trim()}
                type="submit"
              >
                <Ban size={15} /> Remove Station
              </Button>
            </form>
          )}
        </Section>
      )}

      <Section title="Revisions">
        <p>
          {station.revisionCount === 0
            ? "No revisions requested."
            : `${station.revisionCount} ${station.revisionCount === 1 ? "revision" : "revisions"} requested in total.`}
          {station.retryCount
            ? ` ${station.retryCount} since the last restart.`
            : ""}
        </p>
        {/* While revising, the callout above already shows this review. */}
        {station.lastReview && state.status !== "revising" && (
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

const MAX_CONSIST = 12
const loading = new Set([
  "signaled",
  "active",
  "ready_for_pickup",
  "in_review",
  "revising",
])

/** The Train drawn as a locomotive and its Cars: accepted Cars filled, the
 * Car being worked on pulsing, and the Line's remaining Stations as outlines. */
function Consist({
  color,
  cars,
  stations,
  name,
}: {
  color: string
  cars: Car[]
  stations: Station[]
  name: (id: string) => string
}) {
  const open = stations.filter(
    (s) => s.state.status !== "complete" && s.state.status !== "cancelled"
  )
  const slots = [
    ...cars.map((car) => ({
      key: car.id,
      kind: "accepted",
      title: `Car ${car.position} · ${name(car.stationId)}`,
    })),
    ...open.map((s) => ({
      key: s.id,
      kind: loading.has(s.state.status)
        ? "loading"
        : s.state.status === "blocked"
          ? "blocked"
          : "planned",
      title: `${s.name} · ${s.state.status.replaceAll("_", " ")}`,
    })),
  ]
  const shown = slots.slice(0, MAX_CONSIST)
  const loadingCount = open.filter((s) => loading.has(s.state.status)).length
  return (
    <div className="consist-wrap">
      <div
        className="consist"
        style={{ "--line": color } as CSSProperties}
        role="img"
        aria-label={`${cars.length} accepted ${cars.length === 1 ? "Car" : "Cars"}, ${open.length} Stations to go`}
      >
        <span className="consist-loco">
          <TrainFront size={13} />
        </span>
        {shown.map((slot) => (
          <span
            key={slot.key}
            className={`consist-car consist-${slot.kind}`}
            title={slot.title}
          />
        ))}
        {slots.length > shown.length && (
          <span className="consist-more">+{slots.length - shown.length}</span>
        )}
      </div>
      <p className="detail-note">
        {cars.length} accepted
        {loadingCount > 0 && ` · ${loadingCount} loading`}
        {open.length - loadingCount > 0 &&
          ` · ${open.length - loadingCount} to go`}
      </p>
    </div>
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
  const color = lineColor(line, snapshot.lines.indexOf(line))
  const stations = line.stationIds.flatMap(
    (id) => snapshot.stations.find((s) => s.id === id) ?? []
  )
  const held = snapshot.holds.some(
    (h) => h.scope.kind === "line" && h.scope.lineId === line.id
  )
  return (
    <>
      {views.length === 0 && (
        <p className="detail-lead">No Train is running on this Line.</p>
      )}
      {views.map(({ train, signal }) => {
        const cars = snapshot.cars.filter((c) => c.trainId === train.id)
        return (
          <div key={train.id} className="detail-train">
            <div className="detail-status">
              <StatusBadge status={train.state.status} dot />
              <span className={`detail-signal signal-${signal ?? "none"}`}>
                {signal ? `Signal ${signal}` : "No current Engineer decision"}
              </span>
            </div>
            <p className="detail-lead">{describeLocation(train.state, name)}</p>
            <TrainPreviewButton trainId={train.id} commit={train.headCommit} />
            {train.state.status === "blocked" && (
              <Callout
                tone="attention"
                icon={<OctagonAlert size={15} />}
                title="Blocked"
              >
                <List items={train.state.issues.map((issue) => issue.detail)} />
                <Button
                  className="callout-action"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => api.clearTrain(train.id))}
                >
                  Clear block
                </Button>
              </Callout>
            )}
            {train.state.status === "held" && (
              <Callout
                tone="held"
                icon={<CirclePause size={15} />}
                title="Held"
              >
                <List
                  items={train.state.reasons.map((r) =>
                    r.kind === "dependency"
                      ? `Waiting for ${name(r.stationId)}`
                      : snapshot.holds.find((h) => h.id === r.holdId)?.note ||
                        r.kind.replaceAll("_", " ")
                  )}
                />
              </Callout>
            )}
            {train.state.status === "siding" && (
              <Section title="On the siding">
                <p>{train.state.reason}</p>
              </Section>
            )}
            <Section title="Cars">
              <Consist
                color={color}
                cars={cars}
                stations={stations}
                name={name}
              />
              {cars.map((car) => (
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
        )
      })}
      <Section title="Station order">
        <ol className="station-order">
          {stations.map((s, i) => (
            <li key={s.id}>
              <button
                onClick={() => onSelect({ lineId: line.id, stationId: s.id })}
              >
                <span>{i + 1}</span>
                {s.name}
                <StatusBadge status={s.state.status} />
                <ArrowUpRight size={14} />
              </button>
            </li>
          ))}
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
