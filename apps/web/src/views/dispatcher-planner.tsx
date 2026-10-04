import { useRef, useState, type FormEvent } from "react"
import { Route, Send, TrainFront } from "lucide-react"
import type { DispatchPlan, NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"
import { ManifestView, TechnicalDetails, manifestFacts } from "./detail-parts"

const statusLabels: Record<DispatchPlan["state"]["status"], string> = {
  planning: "Preparing proposal",
  ready: "Ready to review",
  launching: "Laying Lines",
  starting: "Starting Trains",
  launched: "Launched",
  failed: "Stopped",
}

/** Goal → persisted proposal → explicit launch. */
export function DispatcherPlanner({ snapshot }: { snapshot: NetworkSnapshot }) {
  const [goal, setGoal] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const submission = useRef<{ goal: string; requestId: string } | null>(null)
  const plans = [...snapshot.plans].reverse()
  const plan = selectedId ? plans.find((p) => p.id === selectedId) : plans[0]

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

  function propose(event: FormEvent) {
    event.preventDefault()
    const trimmed = goal.trim()
    if (!trimmed) return
    if (!submission.current || submission.current.goal !== trimmed)
      submission.current = { goal: trimmed, requestId: crypto.randomUUID() }
    const request = submission.current
    void command(async () => {
      const created = await api.proposePlan(snapshot.network.id, request)
      setSelectedId(created.id)
      submission.current = null
    })
  }

  return (
    <div className="dispatcher-layout">
      <form onSubmit={propose} className="dispatcher-form">
        <label htmlFor="dispatch-goal">What should we build?</label>
        <p>
          Describe a goal for this project. The Dispatcher will propose Lines
          and Station manifests for you to review.
        </p>
        <textarea
          id="dispatch-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          maxLength={4000}
          required
          rows={4}
          placeholder="Add an accessible footer and a light/dark theme toggle, with tests."
          disabled={pending}
        />
        <Button type="submit" disabled={pending || !goal.trim()}>
          <Send size={15} />
          {pending ? "Submitting…" : "Propose a plan"}
        </Button>
        {error && (
          <p className="dispatch-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="dispatch-proposal">
        {plans.length > 1 && (
          <label className="dispatch-history">
            Proposal history
            <select
              value={plan?.id ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value)
                setError(null)
              }}
            >
              {plans.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.goal.slice(0, 65)} · {statusLabels[item.state.status]}
                </option>
              ))}
            </select>
          </label>
        )}
        {plan ? (
          <PlanPreview
            plan={plan}
            currentCommit={snapshot.network.terminusCommit}
            pending={pending}
            launch={() =>
              command(() => api.launchPlan(snapshot.network.id, plan.id))
            }
            retry={() =>
              command(() => api.retryPlan(snapshot.network.id, plan.id))
            }
          />
        ) : (
          <div className="dispatch-placeholder">
            <Route size={28} />
            <h3>
              {selectedId
                ? "Waiting for the saved proposal…"
                : "A goal becomes a railway plan"}
            </h3>
            <p>
              Independent work can travel on concurrent Lines. Related steps
              stay together so each Station receives the code accepted before
              it.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function PlanPreview({
  plan,
  currentCommit,
  pending,
  launch,
  retry,
}: {
  plan: DispatchPlan
  currentCommit: string
  pending: boolean
  launch: () => Promise<void>
  retry: () => Promise<void>
}) {
  const { state } = plan
  const stale =
    state.status === "ready" && plan.terminusCommit !== currentCommit
  return (
    <>
      <div className="dispatch-status" role="status">
        <strong>{statusLabels[state.status]}</strong>
        {plan.model === "fake" && <span>Offline simulation</span>}
      </div>
      <p className="dispatch-goal">{plan.goal}</p>
      {state.status === "planning" && (
        <>
          <p>
            The Dispatcher is reading project context and preparing manifests.
            You can leave this page and return to the saved proposal.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void retry()}
          >
            Recover interrupted planning
          </Button>
        </>
      )}
      {state.status === "failed" && (
        <p className="dispatch-error" role="alert">
          {state.message}
        </p>
      )}
      {"proposal" in state && (
        <>
          <div className="dispatch-reasoning">
            <h3>The Dispatcher&rsquo;s plan</h3>
            <p>{state.proposal.summary}</p>
          </div>
          <div className="dispatch-lines">
            {state.proposal.lines.map((line) => (
              <details key={line.key} open>
                <summary>
                  {line.name}
                  <span>
                    {line.stations.length}{" "}
                    {line.stations.length === 1 ? "Station" : "Stations"}
                  </span>
                </summary>
                <ol>
                  {line.stations.map((station) => (
                    <li key={station.key}>
                      <details>
                        <summary>{station.name}</summary>
                        <p>{station.manifest.goal}</p>
                        <ManifestView
                          manifest={station.manifest}
                          name={(key) =>
                            line.stations.find((s) => s.key === key)?.name ??
                            key
                          }
                        />
                        <TechnicalDetails
                          facts={manifestFacts(station.manifest)}
                          summary="Files, contracts and evidence"
                        />
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
          {state.assessment.errors.length > 0 && (
            <div className="dispatch-error" role="alert">
              <strong>Plan needs revision</strong>
              <ul>
                {state.assessment.errors.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p>Request a new proposal with a more focused goal.</p>
            </div>
          )}
          {state.assessment.collisions.length > 0 && (
            <div className="dispatch-forecasts">
              <strong>Possible collisions</strong>
              <p>
                Review these overlaps before launching. Actual changes and
                integration checks determine whether a conflict exists.
              </p>
              <ul>
                {state.assessment.collisions.map((collision, index) => (
                  <li key={index}>
                    <strong>{collision.line}</strong> and{" "}
                    <strong>{collision.otherLine}</strong> both touch{" "}
                    {[...collision.paths, ...collision.contracts].join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stale && (
            <p className="dispatch-error" role="alert">
              Terminus changed since this proposal. Request a fresh plan before
              launching.
            </p>
          )}
          {state.status === "ready" && (
            <Button
              disabled={pending || stale || state.assessment.errors.length > 0}
              onClick={() => void launch()}
            >
              <TrainFront size={16} />
              Launch{" "}
              {state.proposal.lines.length === 1
                ? "Line"
                : `${state.proposal.lines.length} Lines`}
            </Button>
          )}
          {(state.status === "launching" || state.status === "starting") && (
            <>
              <p>
                Launching continues in the background. The map will show the
                saved Lines and Trains.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void retry()}
              >
                Recover interrupted launch
              </Button>
            </>
          )}
          {state.status === "launched" && (
            <p>
              {state.trainIds.length}{" "}
              {state.trainIds.length === 1 ? "Train" : "Trains"} launched.
              Follow their work on the map.
            </p>
          )}
        </>
      )}
    </>
  )
}
