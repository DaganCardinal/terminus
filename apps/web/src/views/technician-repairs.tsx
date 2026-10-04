import { useState } from "react"
import type { NetworkSnapshot, TechnicianRepair } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"
import { namesFor } from "./describe"
import { CheckRow } from "./detail-parts"

const statusLabels: Record<TechnicianRepair["state"]["status"], string> = {
  requested: "Awaiting workspace",
  running: "Resolving conflicts",
  reviewing: "Conductor reviewing",
  ready: "Ready for your approval",
  approved: "Approved; waiting for integration",
  rejected: "Needs intervention",
  failed: "Stopped",
  integrated: "Integrated",
  stale: "Superseded",
}

export function TechnicianRepairs({ snapshot }: { snapshot: NetworkSnapshot }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const repairs = [...(snapshot.repairs ?? [])].reverse()
  const conflicts = snapshot.conflicts.filter(
    (conflict) => conflict.status === "open"
  )
  const name = namesFor(snapshot)
  async function command(run: () => Promise<unknown>) {
    setPending(true)
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPending(false)
    }
  }
  if (!repairs.length && !conflicts.length) return null
  const stale = (repair: TechnicianRepair) =>
    repair.source.terminusCommit !== snapshot.network.terminusCommit ||
    repair.source.trainCommit !==
      snapshot.trains.find((view) => view.train.id === repair.source.trainId)
        ?.train.headCommit
  return (
    <section className="technician-repairs" aria-label="Technician repairs">
      <h3>Technician repairs</h3>
      <p>
        The Technician proposes a focused reconciliation. Review its changes and
        checks before approving integration.
      </p>
      {conflicts.map((conflict) => {
        const repair = repairs.find((item) => item.conflictId === conflict.id)
        const active =
          repair &&
          ["requested", "running", "reviewing", "ready", "approved"].includes(
            repair.state.status
          ) &&
          !stale(repair)
        return (
          !active && (
            <div className="technician-repair" key={conflict.id}>
              <h4>{conflict.trainIds.map(name).join(" and ")}</h4>
              <p>{conflict.description}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void command(() =>
                    api.dispatchTechnician(snapshot.network.id, conflict.id)
                  )
                }
              >
                {repair ? "Dispatch a fresh Technician" : "Dispatch Technician"}
              </Button>
            </div>
          )
        )
      })}
      {repairs.map((repair) => {
        const state = repair.state
        const reviewed = "review" in state
        const isStale =
          ["ready", "approved"].includes(state.status) && stale(repair)
        return (
          <article className="technician-repair" key={repair.id}>
            <h4>{name(repair.source.trainId)}</h4>
            <p className="technician-status" role="status">
              {isStale
                ? "Source moved; dispatch a fresh Technician"
                : statusLabels[state.status]}
            </p>
            <p>{repair.scope.join(", ")}</p>
            {state.status === "failed" && <p>{state.detail}</p>}
            {reviewed && (
              <>
                <p>{state.review.summary}</p>
                {state.review.findings.length > 0 && (
                  <ul>
                    {state.review.findings.map((finding, index) => (
                      <li key={index}>{finding}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {repair.integrationFailure && (
              <div role="alert">
                <p>Integration stopped: {repair.integrationFailure.detail}</p>
                {repair.integrationFailure.evidence && (
                  <CheckRow
                    checks={repair.integrationFailure.evidence.checks}
                  />
                )}
              </div>
            )}
            {"proposal" in state && (
              <>
                {repair.integrationFailure && (
                  <p>Validation before Conductor review</p>
                )}
                <CheckRow checks={state.proposal.evidence.checks} />
                <details>
                  <summary>Reconciliation diff</summary>
                  <pre>
                    {state.repairDiff ||
                      "No edits beyond the recorded conflict resolution."}
                  </pre>
                </details>
                <details>
                  <summary>Full integration diff</summary>
                  <pre>{state.proposal.diff}</pre>
                </details>
                <details>
                  <summary>Provenance</summary>
                  <p>Train {repair.source.trainCommit}</p>
                  <p>Terminus {repair.source.terminusCommit}</p>
                  <p>Candidate {state.proposal.headCommit}</p>
                  <p>
                    {repair.agent.harness} · {repair.agent.model}
                  </p>
                  {reviewed && <p>Conductor · {state.review.model}</p>}
                </details>
              </>
            )}
            {state.status === "ready" && (
              <Button
                size="sm"
                disabled={pending || isStale}
                onClick={() =>
                  void command(() =>
                    api.approveRepair(snapshot.network.id, repair.id)
                  )
                }
              >
                Approve repair and integrate
              </Button>
            )}
          </article>
        )
      })}
      {error && (
        <p className="dispatch-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
