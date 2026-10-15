import { Prose } from "@terminus/ui/components/prose"
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import type {
  Car,
  Junction,
  NetworkSnapshot,
  RepositoryOverview,
  RepositoryFile,
} from "@terminus/protocol"
import {
  Ban,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  FolderGit2,
  LoaderCircle,
  OctagonAlert,
  RotateCcw,
  Square,
  Wrench,
} from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { StatusBadge } from "@/components/status-badge"
import { lineBadge } from "@/map/layout"
import { api } from "@/state/api"
import {
  CheckRow,
  List,
  ManifestView,
  TechnicalDetails,
  shortCommit as baseShortCommit,
} from "./detail-parts"
import { namesFor, trainDisplayStatus } from "./describe"

type Run = (command: () => Promise<unknown>) => Promise<void>
type Details = Awaited<ReturnType<typeof api.junction>>

const shortCommit = (commit: string) =>
  commit.startsWith("fake-")
    ? `fake-…${commit.slice(-14)}`
    : baseShortCommit(commit)

const tones: Record<
  Junction["state"]["status"],
  "moving" | "review" | "blocked" | "done" | "idle"
> = {
  collecting: "moving",
  reviewing: "review",
  ready: "review",
  released: "done",
  blocked: "blocked",
  abandoned: "idle",
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="detail-section">
      <h3>
        {title}
        {count !== undefined && (
          <span className="detail-section-count">{count}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "working" | "review" | "attention" | "done" | "idle"
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

/** A raw unified diff, coloured the way the Changes reader colours patches. */
function Diff({ diff, label }: { diff: string; label: string }) {
  if (!diff.trim()) return <p className="detail-note">No file changes.</p>
  return (
    <pre className="change-diff" tabIndex={0} aria-label={label}>
      <code>
        {diff.split("\n").map((line, i) => (
          <span
            key={i}
            className={
              /^(diff |index |--- |\+\+\+ |@@)/.test(line)
                ? "diff-header"
                : line.startsWith("+")
                  ? "diff-add"
                  : line.startsWith("-")
                    ? "diff-remove"
                    : "diff-context"
            }
          >
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  )
}

function LineChip({
  snapshot,
  lineId,
}: {
  snapshot: NetworkSnapshot
  lineId: string
}) {
  const badge = lineBadge(snapshot, lineId)
  return (
    <i
      className="junction-chip"
      style={{ "--line": badge?.color } as CSSProperties}
      aria-hidden="true"
    >
      {badge?.number.toString().padStart(2, "0")}
    </i>
  )
}

export function JunctionDetails({
  junction: j,
  snapshot,
  run,
  pending,
  onSource,
}: {
  junction: Junction
  snapshot: NetworkSnapshot
  run: Run
  pending: boolean
  onSource: (lineId: string) => void
}) {
  const [details, setDetails] = useState<Details | null>(null),
    [error, setError] = useState<string | null>(null),
    [scope, setScope] = useState(""),
    [repository, setRepository] = useState<RepositoryOverview | null>(null),
    [file, setFile] = useState<RepositoryFile | null>(null),
    [confirmAbandon, setConfirmAbandon] = useState(false)
  useEffect(() => {
    let live = true
    api
      .junction(j.id)
      .then((d) => {
        if (live) {
          setDetails(d)
          setError(null)
        }
      })
      .catch((e) => {
        if (live) setError(String(e))
      })
    return () => {
      live = false
    }
  }, [j.id, snapshot.lastSeq])
  const name = namesFor(snapshot)
  const lineName = (id: string) =>
    snapshot.lines.find((l) => l.id === id)?.name ?? id
  const lineOfTrain = (trainId: string) =>
    snapshot.trains.find((t) => t.train.id === trainId)?.train.lineId
  const status = j.state.status
  const failureId =
    j.state.status === "blocked"
      ? (j.state.integrationId ?? `${j.id}-feature-${j.attempt}`)
      : null
  const approved = snapshot.junctionApprovals?.some(
    (a) => a.junctionId === j.id && a.commit === j.headCommit
  )
  const outgoing = snapshot.lines.find((l) => l.id === j.outgoingLineId)
  const outgoingStops = outgoing?.stationIds.length ?? 0
  const outgoingTrain = snapshot.trains.find(
    (t) => t.train.id === j.outgoingTrainId
  )?.train
  const accepted = j.inputs.length
  const total = j.incomingTrainIds.length
  const featureAccepted =
    !!j.acceptance && (status === "ready" || status === "released")
  const seen = new Set<string>()
  const cars = j.inputs
    .flatMap((i) =>
      i.carIds
        .map((id) => (details?.cars ?? snapshot.cars).find((c) => c.id === id))
        .filter((c) => !!c)
    )
    .filter((c) => {
      const id = c.originCarId ?? c.id
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  const MetIcon = featureAccepted ? CircleCheck : Square

  return (
    <>
      <div className="detail-status">
        <StatusBadge status={status} tone={tones[status]} dot />
        <span className="detail-signal">
          {accepted} of {total} inputs accepted
        </span>
      </div>
      <Prose text={j.brief.goal} className="detail-lead" />

      {status === "collecting" && (
        <Callout
          tone="working"
          icon={<LoaderCircle className="animate-spin" size={15} />}
          title="Collecting inputs"
        >
          <p>
            Each incoming Line is validated and reviewed by the Conductor as it
            arrives. The complete feature is checked once all {total} are in.
          </p>
          <div
            className="junction-progress"
            role="progressbar"
            aria-label="Inputs accepted"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={accepted}
          >
            {j.incomingLineIds.map((id) => (
              <span
                key={id}
                className={
                  j.inputs.some((input) => input.lineId === id)
                    ? "is-accepted"
                    : undefined
                }
              />
            ))}
          </div>
        </Callout>
      )}
      {status === "reviewing" && (
        <Callout
          tone="review"
          icon={<ClipboardCheck size={15} />}
          title="Reviewing the complete feature"
        >
          <p>
            All inputs are in. The Conductor is building, testing and running
            the converged snapshot against the feature brief.
          </p>
        </Callout>
      )}
      {status === "ready" && (
        <Callout
          tone="review"
          icon={<ClipboardCheck size={15} />}
          title={approved ? "Release approved" : "Ready for your release"}
        >
          <p>
            {approved
              ? "Waiting for the remaining gates before the outgoing Train departs."
              : "The complete feature passed validation and review. Releasing it starts the outgoing Line toward Terminus."}
          </p>
          <p>
            Release covers feature snapshot{" "}
            <code>{shortCommit(j.headCommit)}</code>.
          </p>
          {!approved && (
            <Button
              className="callout-action"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(() => api.releaseJunction(j.id, j.headCommit))
              }
            >
              Approve and release feature
            </Button>
          )}
        </Callout>
      )}
      {j.state.status === "released" && (
        <Callout tone="done" icon={<CircleCheck size={15} />} title="Released">
          <p>
            The feature at <code>{shortCommit(j.state.commit)}</code> is on the
            outgoing Line, heading for Terminus.
          </p>
          <Button
            className="callout-action"
            size="sm"
            variant="outline"
            onClick={() => onSource(j.outgoingLineId)}
          >
            Open {lineName(j.outgoingLineId)}
          </Button>
        </Callout>
      )}
      {j.state.status === "blocked" && (
        <Callout
          tone="attention"
          icon={<OctagonAlert size={15} />}
          title="Blocked"
        >
          <List items={j.state.issues.map((i) => i.detail)} />
          <Button
            className="callout-action"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => api.retryJunction(j.id))}
          >
            <RotateCcw size={14} /> Retry convergence
          </Button>
          <div className="junction-repair">
            <label htmlFor={`repair-scope-${j.id}`}>Repair files</label>
            <input
              id={`repair-scope-${j.id}`}
              className="junction-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="src/App.tsx, src/App.test.tsx"
            />
            <p className="detail-note">
              Required for check or review failures. Conflict repairs use the
              recorded conflict files.
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(() =>
                  api.dispatchJunctionRepair(j.id, {
                    failureId: failureId!,
                    ...(scope.trim()
                      ? {
                          scope: scope
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }
                      : {}),
                  })
                )
              }
            >
              <Wrench size={14} /> Dispatch Technician
            </Button>
          </div>
        </Callout>
      )}
      {j.state.status === "abandoned" && (
        <Callout tone="idle" icon={<Ban size={15} />} title="Abandoned">
          <Prose text={j.state.reason} format="plain" />
        </Callout>
      )}

      <Section title="Route" count={`${accepted}/${total}`}>
        <ol className="junction-route">
          {j.incomingLineIds.map((id, i) => {
            const input = j.inputs.findIndex((input) => input.lineId === id)
            const train = snapshot.trains.find(
              (t) => t.train.id === j.incomingTrainIds[i]
            )?.train
            return (
              <li key={id}>
                <button onClick={() => onSource(id)}>
                  <LineChip snapshot={snapshot} lineId={id} />
                  <span className="junction-route-name">{lineName(id)}</span>
                  {input >= 0 ? (
                    <span className="junction-route-merge">
                      #{input + 1} ·{" "}
                      <code>{shortCommit(j.inputs[input]!.mergeCommit)}</code>
                    </span>
                  ) : train ? (
                    <StatusBadge
                      status={trainDisplayStatus(
                        train.state,
                        snapshot.stations
                      )}
                    />
                  ) : (
                    <StatusBadge status="waiting" />
                  )}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            )
          })}
          <li className="junction-route-hub">
            <span className="pstop-hub" aria-hidden="true">
              J
            </span>
            <span className="junction-route-name">{j.name}</span>
            <code title={j.headCommit}>{shortCommit(j.headCommit)}</code>
          </li>
          <li>
            <button onClick={() => onSource(j.outgoingLineId)}>
              <LineChip snapshot={snapshot} lineId={j.outgoingLineId} />
              <span className="junction-route-name">
                {lineName(j.outgoingLineId)}
                <small>
                  {outgoingStops || "No"}{" "}
                  {outgoingStops === 1 ? "Station" : "Stations"} to Terminus
                </small>
              </span>
              {outgoingTrain ? (
                <StatusBadge
                  status={trainDisplayStatus(
                    outgoingTrain.state,
                    snapshot.stations
                  )}
                />
              ) : (
                <span className="junction-route-merge">On release</span>
              )}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </li>
          <li className="junction-route-hub">
            <span className="pstop-hub" aria-hidden="true">
              T
            </span>
            <span className="junction-route-name">Terminus</span>
          </li>
        </ol>
      </Section>

      <Section title="Feature acceptance">
        <ul
          className={
            featureAccepted ? "manifest-checklist is-met" : "manifest-checklist"
          }
        >
          {j.brief.acceptanceCriteria.map((criterion, i) => (
            <li key={i}>
              <MetIcon size={14} aria-hidden="true" />
              <Prose text={criterion} />
            </li>
          ))}
        </ul>
        {j.acceptance && (
          <>
            <h4>Conductor review</h4>
            <Prose text={j.acceptance.review.summary} />
            <List items={j.acceptance.review.findings} />
            <CheckRow checks={j.acceptance.evidence.checks} />
            <details className="changes">
              <summary>Combined feature diff</summary>
              <Diff diff={j.acceptance.diff} label="Combined feature diff" />
            </details>
          </>
        )}
        <TechnicalDetails
          summary="Scope, contracts and invariants"
          facts={[
            { label: "Scope", value: j.brief.scope },
            {
              label: "Contracts",
              value: j.brief.contracts.map(
                (c) => `${c.name} · ${c.kind}, ${c.change.replaceAll("_", " ")}`
              ),
            },
            { label: "Invariants", value: j.brief.invariants },
            {
              label: "Feature checks",
              value: j.brief.validation.map((v) => v.name),
            },
          ]}
        />
      </Section>

      <Section title="Accepted work" count={cars.length}>
        {cars.length === 0 ? (
          <p>No inputs accepted yet.</p>
        ) : (
          <ol className="junction-cars">
            {cars.map((c) => (
              <AcceptedCar
                key={c.id}
                car={c}
                snapshot={snapshot}
                lineId={lineOfTrain(c.trainId)}
                name={name}
              />
            ))}
          </ol>
        )}
      </Section>

      {details && details.attempts.length > 0 && (
        <Section title="Input integrations" count={details.attempts.length}>
          <ol className="junction-cars">
            {details.attempts.map((a) => {
              const lineId = lineOfTrain(a.input.trainId)
              return (
                <li key={a.input.id}>
                  <details>
                    <summary>
                      {lineId && (
                        <LineChip snapshot={snapshot} lineId={lineId} />
                      )}
                      <span className="junction-route-name">
                        {lineId ? lineName(lineId) : "Input"}
                      </span>
                      <StatusBadge
                        status={a.status}
                        tone={
                          a.status === "completed"
                            ? "done"
                            : a.status === "failed"
                              ? "blocked"
                              : a.status === "prepared"
                                ? "review"
                                : "idle"
                        }
                      />
                    </summary>
                    <div className="junction-car-body">
                      <p className="detail-note">
                        Train commit{" "}
                        <code>{shortCommit(a.input.trainCommit)}</code>
                      </p>
                      {a.review && (
                        <>
                          <Prose text={a.review.summary} />
                          <List items={a.review.findings} />
                        </>
                      )}
                      {a.evidence && <CheckRow checks={a.evidence.checks} />}
                      {a.diff != null && (
                        <Diff diff={a.diff} label="Input merge diff" />
                      )}
                    </div>
                  </details>
                </li>
              )
            })}
          </ol>
        </Section>
      )}

      {details && details.repairs.length > 0 && (
        <Section title="Technician repairs" count={details.repairs.length}>
          <ol className="junction-cars">
            {details.repairs.map((r) => (
              <li key={r.id}>
                <details open={r.state.status === "ready"}>
                  <summary>
                    <Wrench size={14} aria-hidden="true" />
                    <span className="junction-route-name">
                      Technician repair
                    </span>
                    <StatusBadge status={r.state.status} />
                  </summary>
                  <div className="junction-car-body">
                    <Prose text={r.description} format="plain" />
                    <List items={r.scope} />
                    {"proposal" in r.state && (
                      <>
                        <CheckRow checks={r.state.proposal.evidence.checks} />
                        <Diff
                          diff={r.state.repairDiff}
                          label="Technician repair diff"
                        />
                      </>
                    )}
                    {"review" in r.state && (
                      <Prose text={r.state.review.summary} />
                    )}
                    {r.state.status === "ready" && (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void run(() =>
                            api.approveJunctionRepair(
                              j.id,
                              r.id,
                              "proposal" in r.state
                                ? r.state.proposal.headCommit
                                : ""
                            )
                          )
                        }
                      >
                        Approve repair candidate
                      </Button>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="Feature repository">
        <p>
          The converged snapshot at <code>{shortCommit(j.headCommit)}</code>,
          forked from Terminus <code>{shortCommit(j.terminusBaseline)}</code>.
        </p>
        {repository ? (
          <ul className="junction-files">
            {repository.files.map((f) => (
              <li key={f.path}>
                <button
                  aria-pressed={file?.path === f.path}
                  onClick={() =>
                    void run(async () =>
                      setFile(
                        file?.path === f.path
                          ? null
                          : await api.junctionFile(
                              j.id,
                              repository.commit,
                              f.path
                            )
                      )
                    )
                  }
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Button
            className="callout-action"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run(async () =>
                setRepository(await api.junctionRepository(j.id))
              )
            }
          >
            <FolderGit2 size={14} /> Browse files
          </Button>
        )}
        {file && (
          <pre
            className="change-diff junction-file"
            tabIndex={0}
            aria-label={file.path}
          >
            <code>{file.content}</code>
          </pre>
        )}
      </Section>

      {!["released", "abandoned"].includes(status) && (
        <Section title="Abandon feature">
          <p>
            Unfinished members move to the siding. Accepted work stays
            inspectable, and nothing reaches Terminus.
          </p>
          {confirmAbandon ? (
            <div className="junction-confirm">
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    api.abandonJunction(j.id, "Feature abandoned by user")
                  )
                }
              >
                <Ban size={14} /> Abandon {j.name}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmAbandon(false)}
              >
                Keep it
              </Button>
            </div>
          ) : (
            <Button
              className="callout-action"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmAbandon(true)}
            >
              <Ban size={14} /> Abandon Junction
            </Button>
          )}
        </Section>
      )}

      <TechnicalDetails
        facts={[
          { label: "Feature snapshot", value: [shortCommit(j.headCommit)] },
          {
            label: "Frozen Terminus baseline",
            value: [shortCommit(j.terminusBaseline)],
          },
          { label: "Repository", value: j.repoId },
          { label: "Conductor", value: j.conductorModel },
        ]}
      />
      {error && <p role="alert">{error}</p>}
    </>
  )
}

/** One accepted Car, folded to its Line and Station until opened. */
function AcceptedCar({
  car,
  snapshot,
  lineId,
  name,
}: {
  car: Car
  snapshot: NetworkSnapshot
  lineId: string | undefined
  name: (id: string) => string
}) {
  const station =
    snapshot.stations.find((s) => s.id === car.stationId)?.name ??
    car.manifest.goal
  return (
    <li>
      <details>
        <summary>
          {lineId && <LineChip snapshot={snapshot} lineId={lineId} />}
          <span className="junction-route-name">
            {station}
            {car.originCarId && <small>Inherited Car</small>}
          </span>
          <code>{shortCommit(car.acceptedCommit)}</code>
        </summary>
        <div className="junction-car-body">
          <Prose text={car.manifest.goal} />
          <h4>Conductor review</h4>
          <Prose text={car.review.summary} />
          <List items={car.review.findings} />
          <CheckRow checks={car.evidence.checks} />
          <ManifestView manifest={car.manifest} name={name} met />
          <details className="changes">
            <summary>Changes</summary>
            {car.diff != null ? (
              <Diff diff={car.diff} label={`Diff for ${station}`} />
            ) : (
              <p className="detail-note">No recorded Station diff.</p>
            )}
          </details>
          <p className="detail-note">
            Accepted {new Date(car.acceptedAt).toLocaleString()}
          </p>
        </div>
      </details>
    </li>
  )
}
