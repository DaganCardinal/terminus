import { Prose } from "@terminus/ui/components/prose"
import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { ArrowUpRight, CirclePause, RotateCcw } from "lucide-react"
import { lineBadge } from "@/map/layout"
import { api } from "@/state/api"
import { namesFor } from "./describe"
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

/** Possible conflicts the Dispatcher reported. Checks it is still running
 * stay silent; only a confirmed pair needs the user. */
export function conflictThreads(snapshot: NetworkSnapshot) {
  const concerns = snapshot.conflictConcerns ?? []
  return {
    reported: concerns.filter((concern) => concern.pair.stage === "confirmed"),
  }
}

/** The Dispatcher's conflict reports. Holding is the user's call; the
 * report itself never moves a Train. */
export function ConflictMessages({
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
  const { reported } = conflictThreads(snapshot)
  const badge = (lineId: string) => {
    const badge = lineBadge(snapshot, lineId)
    return badge ? (
      <LineBadge color={badge.color} number={badge.number} />
    ) : null
  }
  const held = (trainId: string) =>
    snapshot.holds.some(
      (hold) => hold.scope.kind === "train" && hold.scope.trainId === trainId
    )
  return (
    <>
      {reported.map((concern) => {
        const { pair } = concern
        const finding = pair.investigation?.finding
        if (!finding) return null
        const hold = finding.suggestedHold
        const holdLine =
          hold === concern.trainId
            ? concern.lineId
            : hold === pair.otherTrainId
              ? pair.otherLineId
              : undefined
        return (
          <DispatcherMessage
            card
            key={`${concern.watchId}:${pair.otherTrainId}`}
            tone="attention"
            meta={
              <>
                {badge(concern.lineId)} {badge(pair.otherLineId)} Possible{" "}
                {finding.kind === "textual" ? "merge conflict" : "conflict"}
              </>
            }
          >
            <p>
              <strong>{name(concern.lineId)}</strong> and{" "}
              <strong>{name(pair.otherLineId)}</strong> look likely to collide
              when both reach Terminus.
            </p>
            <Prose className="dmsg-quote" text={finding.summary} />
            {finding.paths.length > 0 && (
              <p className="dmsg-hint">
                {finding.paths.slice(0, 6).join(", ")}
                {finding.paths.length > 6
                  ? ` and ${finding.paths.length - 6} more`
                  : ""}
              </p>
            )}
            {(finding.details.length > 0 || pair.investigation) && (
              <details className="dmsg-details">
                <summary>How I checked</summary>
                <p>
                  {pair.route === "overlap"
                    ? "Both Lines touch the same files, so I investigated directly."
                    : "Clef judged the Lines related, so I investigated."}{" "}
                  {pair.investigation?.trialMerge
                    ? pair.investigation.trialMerge.clean
                      ? "A trial merge of both Trains was clean."
                      : `A trial merge of both Trains conflicted in ${pair.investigation.trialMerge.conflictPaths.length} ${pair.investigation.trialMerge.conflictPaths.length === 1 ? "file" : "files"}.`
                    : ""}
                </p>
                {finding.details.length > 0 && (
                  <ul>
                    {finding.details.map((detail, index) => (
                      <li key={index}>
                        <Prose text={detail} />
                      </li>
                    ))}
                  </ul>
                )}
                {pair.investigation?.checks?.length ? (
                  <p>
                    Checks on the merged result:{" "}
                    {pair.investigation.checks
                      .map((check) => `${check.name} ${check.status}`)
                      .join(", ")}
                  </p>
                ) : null}
              </details>
            )}
            <div className="dmsg-actions">
              {hold && holdLine && !held(hold) && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void command(() =>
                      api.placeHold(snapshot.network.id, {
                        kind: "user",
                        scope: { kind: "train", trainId: hold },
                        note: `Held for a possible conflict with ${name(hold === concern.trainId ? pair.otherLineId : concern.lineId)}`,
                      })
                    )
                  }
                >
                  <CirclePause size={14} /> Hold {name(holdLine)}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTrain(concern.lineId)}
              >
                Open {name(concern.lineId)} <ArrowUpRight size={14} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTrain(pair.otherLineId)}
              >
                Open {name(pair.otherLineId)} <ArrowUpRight size={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void command(() =>
                    api.acknowledgeConflictReport(
                      snapshot.network.id,
                      concern.watchId,
                      pair.otherTrainId
                    )
                  )
                }
              >
                Acknowledge
              </Button>
            </div>
          </DispatcherMessage>
        )
      })}
    </>
  )
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
    const badge = lineBadge(snapshot, lineId)
    return badge ? (
      <LineBadge color={badge.color} number={badge.number} />
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
      {(snapshot.engineerNotices ?? [])
        .filter(
          (notice) => !blocked.some((view) => view.train.id === notice.trainId)
        )
        .map((notice) => {
          const train = snapshot.trains.find(
            (view) => view.train.id === notice.trainId
          )?.train
          if (!train) return null
          return (
            <DispatcherMessage
              card
              key={notice.id}
              tone="attention"
              meta={<>{badge(train.lineId)} Engineer concern</>}
            >
              <p>{notice.summary}</p>
              {notice.dependencyIds.map((id) => {
                const station = snapshot.stations.find(
                  (station) => station.id === id
                )
                return station ? (
                  <Button
                    key={id}
                    size="sm"
                    variant="ghost"
                    onClick={() => openTrain(station.lineId)}
                  >
                    Open {station.name} <ArrowUpRight size={14} />
                  </Button>
                ) : null
              })}
              <div className="dmsg-actions">
                {open(train.lineId)}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void command(() =>
                      api.acknowledgeEngineerNotice(
                        snapshot.network.id,
                        notice.id
                      )
                    )
                  }
                >
                  Acknowledge
                </Button>
              </div>
            </DispatcherMessage>
          )
        })}
      {(snapshot.junctions ?? [])
        .filter(
          (j) => j.state.status === "ready" || j.state.status === "blocked"
        )
        .map((j) => (
          <DispatcherMessage
            card
            key={j.id}
            tone={j.state.status === "ready" ? "review" : "attention"}
            meta="Junction"
          >
            <p>
              <strong>{j.name}</strong>{" "}
              {j.state.status === "ready"
                ? "is accepted and waiting for feature release."
                : "needs intervention."}
            </p>
            {j.state.status === "blocked" && (
              <>
                {j.state.issues.map((issue, index) => (
                  <Prose
                    key={index}
                    className="dmsg-quote"
                    text={issue.detail}
                  />
                ))}
              </>
            )}
            <div className="dmsg-actions">
              {open(j.outgoingLineId, "Review Junction")}
            </div>
          </DispatcherMessage>
        ))}
      {blocked.map(({ train }) => {
        if (train.state.status !== "blocked") return null
        const exhausted = train.state.issues.filter(
          (issue) =>
            issue.kind === "station_retries_exhausted" ||
            issue.kind === "engineer_escalated"
        )
        const early = exhausted.some(
          (issue) => issue.kind === "engineer_escalated"
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
              {train.state.issues.map((issue, index) => (
                <Prose key={index} className="dmsg-quote" text={issue.detail} />
              ))}
              {(snapshot.engineerNotices ?? [])
                .filter((notice) => notice.trainId === train.id)
                .map((notice) => (
                  <div key={notice.id}>
                    <p>
                      <strong>{name(train.id)}</strong> · {notice.summary}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void command(() =>
                          api.acknowledgeEngineerNotice(
                            snapshot.network.id,
                            notice.id
                          )
                        )
                      }
                    >
                      Acknowledge
                    </Button>
                  </div>
                ))}
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
                {badge(train.lineId)} {line} ·{" "}
                {early ? "Revisions stopped" : "Revisions used up"}
              </>
            }
          >
            <p>
              <strong>{station?.name ?? name(train.id)}</strong>{" "}
              {early
                ? "kept getting returned, and the Engineer judged another automatic revision unlikely to help, so it stopped the Train and flagged me."
                : "used all its automatic revisions, so the Engineer stopped the Train and flagged me."}
            </p>
            {exhausted.map((issue, index) => (
              <Prose key={index} className="dmsg-quote" text={issue.detail} />
            ))}
            {station?.lastReview && (
              <details className="dmsg-details">
                <summary>Latest Conductor feedback</summary>
                <Prose text={station.lastReview.feedback.summary} />
                {station.lastReview.feedback.findings.length > 0 && (
                  <ul>
                    {station.lastReview.feedback.findings.map(
                      (finding, index) => (
                        <li key={index}>
                          <Prose text={finding} />
                        </li>
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
