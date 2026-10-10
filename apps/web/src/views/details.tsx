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
import {
  CheckRow,
  type Fact,
  List,
  ManifestView,
  Prose,
  TechnicalDetails,
  manifestFacts,
  shortCommit,
} from "./detail-parts"
import { describeEvent, describeLocation, namesFor } from "./describe"
import { JunctionDetails } from "./junctions"
import { UnloadModeSwitch } from "./unload-mode-switch"
import { Crossings } from "./crossings"
import { TrainPreviewButton } from "./train-preview-button"

type Run = (command: () => Promise<unknown>) => Promise<void>

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
  const proposal =
    state.status === "ready_for_pickup" || state.status === "in_review"
      ? state.proposal
      : undefined
  const report = car?.agentSummary ?? proposal?.agentSummary
  const agent = car?.stationAgent ?? proposal?.agent
  const facts: Fact[] = [
    ...(car
      ? [
          {
            label: "Accepted commit",
            value: [shortCommit(car.acceptedCommit)],
          },
          { label: "Forked from", value: [shortCommit(car.sourceCommit)] },
          { label: "Changed files", value: car.changedPaths },
        ]
      : proposal
        ? [
            {
              label: "Candidate commit",
              value: [shortCommit(proposal.headCommit)],
            },
            { label: "Changed files", value: proposal.changedPaths },
          ]
        : "workspace" in state && state.workspace
          ? [
              {
                label: "Forked from",
                value: [shortCommit(state.workspace.baseCommit)],
              },
            ]
          : []),
    ...(agent
      ? [
          {
            label: "Station Agent",
            value: `${agent.model} via ${agent.harness}`,
          },
        ]
      : []),
    ...manifestFacts(manifest),
  ]
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
              : "A Station Agent is working on this in its own isolated workspace."}
          </p>
        </Callout>
      )}
      {proposal && (
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
            {state.status === "in_review"
              ? "The Conductor is checking this work against the manifest before it joins the Train."
              : "The Station Agent has finished. The Conductor will review it next."}
          </p>
          <CheckRow checks={proposal.evidence.checks} />
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
            <CheckRow checks={station.lastReview.proposal.evidence.checks} />
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
          <CheckRow checks={car.evidence.checks} />
        </Callout>
      )}

      {report && (
        <Section title="Station Agent's report">
          <Prose text={report} />
        </Section>
      )}

      <Section title="Work manifest">
        <ManifestView manifest={manifest} name={name} met={!!car} />
      </Section>

      {(station.revisionCount > 0 ||
        station.lastReview ||
        station.runRetries) && (
        <Section title="Revisions">
          <p>
            {station.revisionCount === 0
              ? "No revisions requested."
              : `The Conductor asked for ${station.revisionCount} ${station.revisionCount === 1 ? "revision" : "revisions"}.`}
            {station.runRetries
              ? ` The Engineer restarted ${station.runRetries} failed ${station.runRetries === 1 ? "run" : "runs"}.`
              : ""}
            {station.retryCount
              ? ` ${station.retryCount} automatic ${station.retryCount === 1 ? "retry" : "retries"} used since the last restart.`
              : ""}
          </p>
          {/* While revising, the callout above already shows this review. */}
          {station.lastReview && state.status !== "revising" && (
            <details>
              <summary>Latest Conductor feedback</summary>
              <p>{station.lastReview.feedback.summary}</p>
              <List items={station.lastReview.feedback.findings} />
              <CheckRow checks={station.lastReview.proposal.evidence.checks} />
            </details>
          )}
        </Section>
      )}

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
              className="removal-form"
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
                placeholder="e.g. Redundant with an earlier Station"
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

      <TechnicalDetails facts={facts} />
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
}: {
  color: string
  cars: Car[]
  stations: Station[]
}) {
  const open = stations.filter(
    (s) => s.state.status !== "complete" && s.state.status !== "cancelled"
  )
  const slots = [
    ...cars.map((car) => ({
      key: car.id,
      kind: "accepted",
    })),
    ...open.map((s) => ({
      key: s.id,
      kind: loading.has(s.state.status)
        ? "loading"
        : s.state.status === "blocked"
          ? "blocked"
          : "planned",
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
          <span key={slot.key} className={`consist-car consist-${slot.kind}`} />
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
  const junction = snapshot.junctions?.find(
    (j) => j.incomingLineIds.includes(line.id) || j.outgoingLineId === line.id
  )
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
      {junction && (
        <details>
          <summary>
            Junction · {junction.name} · {junction.state.status}
          </summary>
          <JunctionDetails
            junction={junction}
            snapshot={snapshot}
            run={run}
            pending={pending}
            onSource={(lineId) => onSelect({ lineId })}
          />
        </details>
      )}
      {views.length === 0 && (
        <p className="detail-lead">No Train is running on this Line.</p>
      )}
      {views.map(({ train, signal }) => {
        const cars = snapshot.cars.filter((c) => c.trainId === train.id)
        const policy = snapshot.unloadPolicies?.find(
          (p) => p.trainId === train.id
        )
        const approved = policy?.approval?.trainCommit === train.headCommit
        const atEntry =
          (train.state.status === "returning" &&
            train.state.phase === "awaiting_clearance") ||
          (train.state.status === "held" &&
            train.state.resume.status === "returning")
        const closed =
          ["unloaded", "siding"].includes(train.state.status) ||
          (train.state.status === "returning" &&
            train.state.phase === "integrating")
        return (
          <div key={train.id} className="detail-train">
            <div className="detail-status">
              <StatusBadge status={train.state.status} dot />
              <span className={`detail-signal signal-${signal ?? "none"}`}>
                {signal ? `Signal ${signal}` : "No current Engineer decision"}
              </span>
            </div>
            <p className="detail-lead">
              {describeLocation(train.state, name, train.destination)}
            </p>
            <TrainPreviewButton trainId={train.id} commit={train.headCommit} />
            {train.destination?.kind !== "junction" && (
              <UnloadModeSwitch
                mode={policy?.mode ?? "auto"}
                recommendation={policy?.recommendation}
                disabled={pending || closed}
                onChange={(mode) =>
                  void run(() => api.setTrainUnloadMode(train.id, mode))
                }
              />
            )}
            {train.destination?.kind !== "junction" &&
              policy?.mode === "human_approval" &&
              atEntry && (
                <Callout
                  tone="review"
                  icon={<ClipboardCheck size={15} />}
                  title={
                    approved
                      ? "Approved for unloading"
                      : "Review before unloading"
                  }
                >
                  <p>
                    {approved
                      ? "Waiting for the remaining Terminus gates to clear."
                      : "Review the accepted Cars and preview the Train before approving unloading."}
                  </p>
                  <p>
                    Approval covers Train commit{" "}
                    <code>{shortCommit(train.headCommit)}</code>. The merge with
                    current Terminus will be validated afterward.
                  </p>
                  {!approved && (
                    <Button
                      className="callout-action"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void run(() =>
                          api.approveTrainUnload(train.id, train.headCommit)
                        )
                      }
                    >
                      Approve unloading
                    </Button>
                  )}
                </Callout>
              )}
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
                    r.kind === "awaiting_user_approval"
                      ? "In the review yard, awaiting human approval"
                      : r.kind === "dependency"
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
            <Crossings
              snapshot={snapshot}
              lineId={line.id}
              run={run}
              pending={pending}
              onSource={(lineId, stationId) => onSelect({ lineId, stationId })}
            />
            <Section title="Cars">
              <Consist color={color} cars={cars} stations={stations} />
              {cars.map((car) => (
                <details key={car.id}>
                  <summary>
                    {car.position}. {name(car.stationId)}
                  </summary>
                  <p>{car.manifest.goal}</p>
                  {car.originCarId && (
                    <p>
                      Picked up from{" "}
                      <button
                        className="dmsg-link"
                        onClick={() => {
                          const origin = snapshot.cars.find(
                            (c) => c.id === car.originCarId
                          )
                          const t = snapshot.trains.find(
                            (t) => t.train.id === origin?.trainId
                          )
                          if (t)
                            onSelect({
                              lineId: t.train.lineId,
                              stationId: car.stationId,
                            })
                        }}
                      >
                        original Car {car.originCarId}
                      </button>
                      . Original acceptance and review are preserved.
                    </p>
                  )}
                  <p>
                    <strong>Conductor review:</strong> {car.review.summary}
                  </p>
                  <List items={car.review.findings} />
                  <CheckRow checks={car.evidence.checks} />
                  <ManifestView manifest={car.manifest} name={name} met />
                  <TechnicalDetails
                    facts={[
                      { label: "Accepted commit", value: car.acceptedCommit },
                      { label: "Changed files", value: car.changedPaths },
                    ]}
                  />
                  <details>
                    <summary>Accepted changes</summary>
                    {car.diff !== undefined ? (
                      <pre className="unload-diff">
                        {car.diff || "No file changes."}
                      </pre>
                    ) : (
                      <p>A diff was not recorded for this Car.</p>
                    )}
                  </details>
                </details>
              ))}
            </Section>
          </div>
        )
      })}
      <Section title="Station order">
        <ol className="station-order">
          {(
            line.stops ??
            line.stationIds.map((stationId) => ({
              kind: "station" as const,
              stationId,
            }))
          ).map((stop, i) => {
            const s = snapshot.stations.find((s) => s.id === stop.stationId)
            if (!s) return null
            return (
              <li key={s.id}>
                <button
                  onClick={() =>
                    onSelect({ lineId: s.lineId, stationId: s.id })
                  }
                >
                  <span>{i + 1}</span>
                  {stop.kind === "crossing" ? `Pickup at ${s.name}` : s.name}
                  <StatusBadge
                    status={
                      stop.kind === "crossing"
                        ? (snapshot.crossings?.find(
                            (c) => c.id === stop.crossingId
                          )?.state.status ?? "waiting")
                        : s.state.status
                    }
                  />
                  <ArrowUpRight size={14} />
                </button>
              </li>
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
          </li>
        ))}
    </ol>
  )
}
