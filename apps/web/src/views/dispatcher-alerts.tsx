import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { AlertTriangle, ArrowUpRight } from "lucide-react"
import { describeIssues, namesFor } from "./describe"

/** User-facing projection of issues the Engineer raised to the Dispatcher,
 * plus anything else that puts the Dispatcher in its attention state. */
export function DispatcherAlerts({
  snapshot,
  pending,
  error,
  retry,
  openTrain,
}: {
  snapshot: NetworkSnapshot
  pending: boolean
  error: string | null
  retry: (trainId: string) => Promise<void>
  openTrain: (lineId: string) => void
}) {
  const name = namesFor(snapshot)
  const blocked = snapshot.trains.filter(
    ({ train }) => train.state.status === "blocked"
  )
  const exhausted = (view: (typeof blocked)[number]) =>
    view.train.state.status === "blocked" &&
    view.train.state.issues.some(
      (issue) => issue.kind === "station_retries_exhausted"
    )
  const stopped = blocked.filter(exhausted)
  const otherBlocked = blocked.filter((view) => !exhausted(view))
  const conflicts = snapshot.conflicts.filter((c) => c.status === "open")
  if (!blocked.length && !conflicts.length) return null
  return (
    <section className="dispatcher-alerts" aria-label="Dispatcher alerts">
      <h3>
        <AlertTriangle size={16} /> User attention needed
      </h3>
      <div className="dispatcher-alert-body" role="alert">
        {stopped.length > 0 && (
          <p>
            The Engineer stopped automatic retries and flagged the Dispatcher.
            These Stations need your intervention.
          </p>
        )}
        {stopped.map(({ train }) => {
          const station = snapshot.stations.find(
            (s) =>
              s.lineId === train.lineId &&
              s.state.status === "blocked" &&
              s.state.trainId === train.id
          )
          return (
            <div key={train.id} className="dispatcher-alert-item">
              <h4>
                {station?.name ?? name(train.id)} · {name(train.lineId)}
              </h4>
              {train.state.status === "blocked" &&
                train.state.issues
                  .filter((issue) => issue.kind === "station_retries_exhausted")
                  .map((issue, index) => <p key={index}>{issue.detail}</p>)}
              {station?.lastReview && (
                <details>
                  <summary>Latest feedback and validation</summary>
                  <p>{station.lastReview.feedback.summary}</p>
                  <ul>
                    {station.lastReview.feedback.findings.map(
                      (finding, index) => (
                        <li key={index}>{finding}</li>
                      )
                    )}
                  </ul>
                  <p>
                    Candidate{" "}
                    <code>{station.lastReview.proposal.headCommit}</code>
                  </p>
                  <ul>
                    {station.lastReview.proposal.evidence.checks.map(
                      (check, index) => (
                        <li key={index}>
                          {check.name}: {check.status}
                        </li>
                      )
                    )}
                  </ul>
                </details>
              )}
              <p>
                Review the feedback before retrying. A retry starts a fresh
                workspace with a new retry allowance.
              </p>
              <div className="dispatcher-alert-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void retry(train.id)}
                >
                  Retry Station after intervention
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openTrain(train.lineId)}
                >
                  Open Train <ArrowUpRight size={14} />
                </Button>
              </div>
            </div>
          )
        })}
        {otherBlocked.map(({ train }) => (
          <div key={train.id} className="dispatcher-alert-item">
            <h4>{name(train.id)} is blocked</h4>
            {train.state.status === "blocked" && (
              <p>{describeIssues(train.state.issues)}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => openTrain(train.lineId)}
            >
              Open Train <ArrowUpRight size={14} />
            </Button>
          </div>
        ))}
        {conflicts.map((conflict) => (
          <div key={conflict.id} className="dispatcher-alert-item">
            <h4>
              Conflict between {conflict.trainIds.map(name).join(" and ")}
            </h4>
            <p>{conflict.description}</p>
            {conflict.paths.length > 0 && (
              <p>
                <code>{conflict.paths.join(", ")}</code>
              </p>
            )}
          </div>
        ))}
        {error && <p className="dispatch-error">{error}</p>}
      </div>
    </section>
  )
}
