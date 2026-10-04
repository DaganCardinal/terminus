import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { ArrowUpRight, RotateCcw } from "lucide-react"
import { lineColor } from "@/map/layout"
import { api } from "@/state/api"
import { describeIssues, namesFor } from "./describe"
import { CheckRow } from "./detail-parts"
import { DispatcherMessage, LineBadge } from "./dispatcher-message"

type Command = (run: () => Promise<unknown>) => Promise<void>

/** Trains whose Engineer flagged the Dispatcher, and Trains waiting in the
 * review yard for the user. Each is something the Dispatcher tells the user. */
export function attentionTrains(snapshot: NetworkSnapshot) {
  const blocked = snapshot.trains.filter(
    ({ train }) => train.state.status === "blocked"
  )
  const awaiting = snapshot.trains.filter(
    ({ train }) =>
      train.state.status === "held" &&
      train.state.reasons.some((r) => r.kind === "awaiting_user_approval")
  )
  return { blocked, awaiting }
}

export function AttentionMessages({
  snapshot,
  pending,
  command,
  openTrain,
}: {
  snapshot: NetworkSnapshot
  pending: boolean
  command: Command
  openTrain: (lineId: string) => void
}) {
  const name = namesFor(snapshot)
  const { blocked, awaiting } = attentionTrains(snapshot)
  const badge = (lineId: string) => {
    const index = snapshot.lines.findIndex((line) => line.id === lineId)
    const line = snapshot.lines[index]
    return line ? (
      <LineBadge color={lineColor(line, index)} number={index + 1} />
    ) : null
  }
  const open = (
    lineId: string,
    label = "Open Train",
    variant: "outline" | "ghost" = "outline"
  ) => (
    <Button size="sm" variant={variant} onClick={() => openTrain(lineId)}>
      {label} <ArrowUpRight size={14} />
    </Button>
  )
  return (
    <>
      {blocked.map(({ train }) => {
        if (train.state.status !== "blocked") return null
        const exhausted = train.state.issues.filter(
          (issue) => issue.kind === "station_retries_exhausted"
        )
        const line = name(train.lineId)
        if (!exhausted.length)
          return (
            <DispatcherMessage
              card
              key={train.id}
              tone="attention"
              meta={<>{badge(train.lineId)} Train blocked</>}
            >
              <p>
                <strong>{name(train.id)}</strong> has stopped and needs you.
              </p>
              <p className="dmsg-quote">{describeIssues(train.state.issues)}</p>
              <div className="dmsg-actions">{open(train.lineId)}</div>
            </DispatcherMessage>
          )
        const station = snapshot.stations.find(
          (s) =>
            s.lineId === train.lineId &&
            s.state.status === "blocked" &&
            s.state.trainId === train.id
        )
        return (
          <DispatcherMessage
            card
            key={train.id}
            tone="attention"
            meta={
              <>
                {badge(train.lineId)} {line} · Revisions used up
              </>
            }
          >
            <p>
              <strong>{station?.name ?? name(train.id)}</strong> used all its
              automatic revisions, so the Engineer stopped the Train and flagged
              me.
            </p>
            {exhausted.map((issue, index) => (
              <p key={index} className="dmsg-quote">
                {issue.detail}
              </p>
            ))}
            {station?.lastReview && (
              <details className="dmsg-details">
                <summary>Latest Conductor feedback</summary>
                <p>{station.lastReview.feedback.summary}</p>
                {station.lastReview.feedback.findings.length > 0 && (
                  <ul>
                    {station.lastReview.feedback.findings.map(
                      (finding, index) => (
                        <li key={index}>{finding}</li>
                      )
                    )}
                  </ul>
                )}
                <CheckRow
                  checks={station.lastReview.proposal.evidence.checks}
                />
              </details>
            )}
            <p className="dmsg-hint">
              A retry starts a fresh workspace with a new revision allowance.
            </p>
            <div className="dmsg-actions">
              <Button
                size="sm"
                disabled={pending}
                onClick={() => void command(() => api.clearTrain(train.id))}
              >
                <RotateCcw size={14} /> Retry Station
              </Button>
              {open(train.lineId, "Review in Train", "ghost")}
            </div>
          </DispatcherMessage>
        )
      })}
      {awaiting.map(({ train }) => (
        <DispatcherMessage
          card
          key={train.id}
          tone="review"
          meta={<>{badge(train.lineId)} Waiting in the review yard</>}
        >
          <p>
            <strong>{name(train.id)}</strong> finished its Stations and is
            waiting in the review yard. Look over its Cars and approve unloading
            when you&rsquo;re happy.
          </p>
          <div className="dmsg-actions">
            {open(train.lineId, "Review Train")}
          </div>
        </DispatcherMessage>
      ))}
    </>
  )
}
