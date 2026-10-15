import { Prose } from "@terminus/ui/components/prose"
import type { NetworkSnapshot, TechnicianRepair } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { ArrowUpRight, Check, Wrench } from "lucide-react"
import { lineBadge } from "@/map/layout"
import { api } from "@/state/api"
import { modelWithReasoning, namesFor } from "./describe"
import { CheckRow, Tags, shortCommit } from "./detail-parts"
import {
  AbsorbedNotices,
  activeRepairStatuses,
  repairThreads,
} from "./dispatcher-alerts"
import { DispatcherMessage, LineBadge } from "./dispatcher-message"
import type { DispatcherTone } from "./dispatcher-state"

type Command = (run: () => Promise<unknown>) => Promise<void>
type Status = TechnicianRepair["state"]["status"]

const active = activeRepairStatuses

/** The path a repair travels; failures and staleness leave it. */
const stages: { label: string; reached: Status[] }[] = [
  { label: "Workspace", reached: ["requested"] },
  { label: "Resolving", reached: ["running"] },
  { label: "Conductor review", reached: ["reviewing"] },
  { label: "Your approval", reached: ["ready"] },
  { label: "Integrating", reached: ["approved"] },
  { label: "Integrated", reached: ["integrated"] },
]

const statusLines: Record<Status, string> = {
  requested: "I’ve asked for a Technician workspace.",
  running: "The Technician is reconciling the conflicting changes.",
  reviewing: "The Conductor is reviewing the Technician’s candidate.",
  ready: "The repair passed review. It needs your approval to integrate.",
  approved: "Approved. Waiting for Terminus integration.",
  rejected: "The Conductor didn’t accept this repair. It needs intervention.",
  failed: "The repair stopped.",
  integrated: "The repair is integrated into Terminus.",
  stale: "The source moved after this repair was prepared.",
}

/** Where a conflict's latest repair stands. A stale candidate can no longer
 * be approved, so only a fresh Technician moves it on. */
export function repairProgress(
  snapshot: NetworkSnapshot,
  repair: TechnicianRepair | undefined
) {
  const state = repair?.state
  const isStale =
    !!repair &&
    !!state &&
    ["ready", "approved"].includes(state.status) &&
    (repair.source.terminusCommit !== snapshot.network.terminusCommit ||
      repair.source.trainCommit !==
        snapshot.trains.find((view) => view.train.id === repair.source.trainId)
          ?.train.headCommit)
  const working =
    !!repair && !!state && active.includes(state.status) && !isStale
  return { isStale, working }
}

/** One card per conflict at Terminus. A Train the conflict blocked is told
 * here too, rather than in a card of its own. */
export function RepairMessages({
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
  const networkId = snapshot.network.id

  return repairThreads(snapshot).map(({ conflict, repair, trainIds }) => {
    const trains = trainIds.flatMap(
      (id) => snapshot.trains.find((view) => view.train.id === id)?.train ?? []
    )
    const blocked = trains.filter((train) => train.state.status === "blocked")
    const state = repair?.state
    const { isStale, working } = repairProgress(snapshot, repair)
    const tone: DispatcherTone =
      state?.status === "ready" && !isStale
        ? "review"
        : working
          ? "working"
          : "attention"
    const key = conflict?.id ?? repair!.conflictId
    return (
      <DispatcherMessage
        card
        key={key}
        tone={tone}
        meta={
          <>
            {trains.map((train) => {
              const badge = lineBadge(snapshot, train.lineId)
              return badge ? (
                <LineBadge
                  key={train.id}
                  color={badge.color}
                  number={badge.number}
                />
              ) : null
            })}{" "}
            {repair ? "Technician repair" : "Conflict at Terminus"}
          </>
        }
      >
        {conflict ? (
          <>
            <p>
              {conflict.trainIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && " and "}
                  <strong>{name(id)}</strong>
                </span>
              ))}{" "}
              conflict at Terminus.
            </p>
            <Prose
              text={conflict.description}
              className="dmsg-quote"
              format="plain"
            />
            {conflict.paths.length > 0 && <Tags items={conflict.paths} />}
          </>
        ) : (
          repair && (
            <p>
              Repairing <strong>{name(repair.source.trainId)}</strong>.
            </p>
          )
        )}

        {repair && state && (
          <>
            <RepairStages status={state.status} />
            <p>
              {isStale
                ? "The Train or Terminus moved after this repair was prepared, so it can’t be approved."
                : statusLines[state.status]}
            </p>
            {state.status === "failed" && (
              <Prose text={state.detail} className="dmsg-quote" />
            )}
            {"review" in state && (
              <div className="dmsg-quote">
                <Prose text={state.review.summary} />
                {state.review.findings.length > 0 && (
                  <ul>
                    {state.review.findings.map((finding, index) => (
                      <li key={index}>
                        <Prose text={finding} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {repair.integrationFailure && (
              <div className="dmsg-quote" role="alert">
                <p>Integration stopped:</p>
                <Prose text={repair.integrationFailure.detail} />
                {repair.integrationFailure.evidence && (
                  <CheckRow
                    checks={repair.integrationFailure.evidence.checks}
                  />
                )}
              </div>
            )}
            {"proposal" in state && (
              <>
                <CheckRow checks={state.proposal.evidence.checks} />
                <details className="dmsg-details">
                  <summary>Reconciliation diff</summary>
                  <pre>
                    {state.repairDiff ||
                      "No edits beyond the recorded conflict resolution."}
                  </pre>
                </details>
                <details className="dmsg-details">
                  <summary>Full integration diff</summary>
                  <pre>{state.proposal.diff}</pre>
                </details>
                <details className="dmsg-details">
                  <summary>Provenance</summary>
                  <dl className="dmsg-facts">
                    <dt>Train</dt>
                    <dd>
                      <code>{shortCommit(repair.source.trainCommit)}</code>
                    </dd>
                    <dt>Terminus</dt>
                    <dd>
                      <code>{shortCommit(repair.source.terminusCommit)}</code>
                    </dd>
                    <dt>Candidate</dt>
                    <dd>
                      <code>{shortCommit(state.proposal.headCommit)}</code>
                    </dd>
                    <dt>Technician</dt>
                    <dd>
                      {repair.agent.harness} ·{" "}
                      {modelWithReasoning(repair.agent)}
                    </dd>
                    {"review" in state && (
                      <>
                        <dt>Conductor</dt>
                        <dd>{modelWithReasoning(state.review)}</dd>
                      </>
                    )}
                  </dl>
                </details>
              </>
            )}
          </>
        )}

        {blocked.map((train) => (
          <div key={train.id}>
            {train.state.status === "blocked" &&
              train.state.issues
                .filter((issue) => issue.kind !== "conflict")
                .map((issue, index) => (
                  <Prose
                    key={index}
                    className="dmsg-quote"
                    text={issue.detail}
                  />
                ))}
            <AbsorbedNotices
              snapshot={snapshot}
              trainId={train.id}
              pending={pending}
              command={command}
            />
          </div>
        ))}

        <div className="dmsg-actions">
          {state?.status === "ready" && (
            <Button
              size="sm"
              disabled={pending || isStale}
              onClick={() =>
                void command(() => api.approveRepair(networkId, repair!.id))
              }
            >
              <Check size={14} /> Approve and integrate
            </Button>
          )}
          {conflict?.status === "open" && !working && (
            <Button
              size="sm"
              variant={repair ? "outline" : "default"}
              disabled={pending}
              onClick={() =>
                void command(() =>
                  api.dispatchTechnician(networkId, conflict.id)
                )
              }
            >
              <Wrench size={14} />
              {repair ? "Dispatch a fresh Technician" : "Dispatch Technician"}
            </Button>
          )}
          {trains.map((train) => (
            <Button
              key={train.id}
              size="sm"
              variant="ghost"
              onClick={() => openTrain(train.lineId)}
            >
              Open {trains.length > 1 ? name(train.id) : "Train"}{" "}
              <ArrowUpRight size={14} />
            </Button>
          ))}
        </div>
        {conflict?.status === "open" && !repair && (
          <p className="dmsg-hint">
            The Technician works in an isolated workspace. Nothing reaches
            Terminus until you approve its reviewed repair.
          </p>
        )}
      </DispatcherMessage>
    )
  })
}

function RepairStages({ status }: { status: Status }) {
  const current = stages.findIndex((stage) => stage.reached.includes(status))
  if (current < 0) return null
  return (
    <ol className="repair-stages" aria-label="Repair progress">
      {stages.map((stage, index) => (
        <li
          key={stage.label}
          className={
            index < current ? "done" : index === current ? "current" : undefined
          }
          aria-current={index === current ? "step" : undefined}
        >
          {stage.label}
        </li>
      ))}
    </ol>
  )
}
