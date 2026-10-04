import { useRef, useState, type CSSProperties, type ReactNode } from "react"
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitCompareArrows,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  TrainFront,
} from "lucide-react"
import type {
  DispatchPlan,
  NetworkSnapshot,
  UnloadMode,
} from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { lineColor } from "@/map/layout"
import { api } from "@/state/api"
import {
  ManifestView,
  Prose,
  TechnicalDetails,
  changeKinds,
  manifestFacts,
  shortCommit,
} from "./detail-parts"
import {
  DispatcherMessage,
  Typing,
  UserMessage,
  useNow,
} from "./dispatcher-message"

type Command = (run: () => Promise<unknown>) => Promise<void>
type Reviewed = Extract<DispatchPlan["state"], { proposal: unknown }>
type PlannedLine = Reviewed["proposal"]["lines"][number]

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** One request in the Dispatcher thread: the user's goal, then the
 * Dispatcher's reply as it moves from drafting to a launched plan. */
export function PlanExchange({
  plan,
  snapshot,
  latest,
  pending,
  command,
  refine,
  propose,
  openTrain,
}: {
  plan: DispatchPlan
  snapshot: NetworkSnapshot
  latest: boolean
  pending: boolean
  command: Command
  refine: (goal: string) => void
  propose: (goal: string) => void
  openTrain: (lineId: string) => void
}) {
  const { state } = plan
  const networkId = snapshot.network.id
  const retry = () => command(() => api.retryPlan(networkId, plan.id))
  return (
    <div className="exchange" data-plan={plan.id}>
      <UserMessage text={plan.goal} at={plan.createdAt} />
      {state.status === "planning" ? (
        <Drafting plan={plan} pending={pending} retry={retry} />
      ) : state.status === "failed" ? (
        <DispatcherMessage tone="attention" meta="Plan stopped">
          <p>I couldn&rsquo;t turn this into a plan.</p>
          <p className="dmsg-error">{state.message}</p>
          <div className="dmsg-actions">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => propose(plan.goal)}
            >
              <RefreshCw size={14} /> Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => refine(plan.goal)}>
              <PencilLine size={14} /> Edit goal
            </Button>
          </div>
        </DispatcherMessage>
      ) : (
        <Proposal
          plan={plan}
          state={state}
          snapshot={snapshot}
          latest={latest}
          pending={pending}
          launch={() => command(() => api.launchPlan(networkId, plan.id))}
          selectMode={(lineKey, mode) =>
            command(() =>
              api.selectPlanUnloadMode(networkId, plan.id, lineKey, mode)
            )
          }
          retry={retry}
          refine={refine}
          propose={propose}
          openTrain={openTrain}
        />
      )}
    </div>
  )
}

/** The Dispatcher is reading the project and writing manifests. Elapsed
 * time is real; nothing here pretends to measure progress. */
function Drafting({
  plan,
  pending,
  retry,
}: {
  plan: DispatchPlan
  pending: boolean
  retry: () => Promise<void>
}) {
  const now = useNow(1000)
  const seconds = Math.max(
    0,
    Math.round((now - Date.parse(plan.createdAt)) / 1000)
  )
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`
  return (
    <DispatcherMessage tone="working" meta="Drafting a plan">
      <p className="dmsg-status" role="status">
        <Typing />
        <span>
          Reading the project at <code>{shortCommit(plan.terminusCommit)}</code>{" "}
          and drafting Lines and Station manifests
        </span>
      </p>
      <p className="dmsg-hint">
        <span className="tabular">{elapsed}</span> · The proposal is saved when
        it&rsquo;s ready, so you can close this panel.
      </p>
      {seconds > 90 && (
        <button
          className="dmsg-link"
          disabled={pending}
          onClick={() => void retry()}
        >
          Taking too long? Recover planning
        </button>
      )}
    </DispatcherMessage>
  )
}

function Proposal({
  plan,
  state,
  snapshot,
  latest,
  pending,
  launch,
  selectMode,
  retry,
  refine,
  propose,
  openTrain,
}: {
  plan: DispatchPlan
  state: Reviewed
  snapshot: NetworkSnapshot
  latest: boolean
  pending: boolean
  launch: () => Promise<void>
  selectMode: (lineKey: string, mode: UnloadMode) => Promise<void>
  retry: () => Promise<void>
  refine: (goal: string) => void
  propose: (goal: string) => void
  openTrain: (lineId: string) => void
}) {
  const { proposal, assessment } = state
  const launched = state.status === "launched"
  // Older and launched plans fold to a summary so the thread stays readable.
  const [showPlan, setShowPlan] = useState(latest && !launched)
  const lines = proposal.lines
  const stations = lines.reduce((n, line) => n + line.stations.length, 0)
  const lineIds = "lineIds" in state ? state.lineIds : []
  const launchedLines = lineIds
    .map((id) => snapshot.lines.find((line) => line.id === id))
    .filter((line) => line !== undefined)
  // Planned Lines are appended to the network, so they take the next colours.
  const color = (index: number) => {
    const line = launchedLines[index]
    return line
      ? lineColor(line, snapshot.lines.indexOf(line))
      : lineColor(lines[index]!, snapshot.lines.length + index)
  }
  const number = (index: number) => {
    const line = launchedLines[index]
    return (
      (line ? snapshot.lines.indexOf(line) : snapshot.lines.length + index) + 1
    )
  }
  const stale =
    state.status === "ready" &&
    plan.terminusCommit !== snapshot.network.terminusCommit
  const blocked = assessment.errors.length > 0
  const shape = `${plural(lines.length, "Line")} · ${plural(stations, "Station")}`

  const superseded = state.status === "ready" && !latest
  const summary = launched
    ? `Launched ${plural(lines.length, "Line")}.`
    : superseded
      ? `Proposed ${plural(lines.length, "Line")}; not launched.`
      : null
  const issues = assessment.errors.length + (stale ? 1 : 0)
  const notes = useRef<HTMLDivElement>(null)

  return (
    <DispatcherMessage
      tone={
        launched || superseded
          ? "idle"
          : state.status === "ready"
            ? issues
              ? "attention"
              : "review"
            : "working"
      }
      meta={
        launched
          ? "Launched"
          : superseded
            ? "Earlier proposal"
            : state.status === "ready"
              ? issues
                ? "Plan needs changes"
                : "Ready for your review"
              : "Launching"
      }
    >
      {summary && !showPlan ? (
        <>
          <p>
            {summary}{" "}
            <button className="dmsg-link" onClick={() => setShowPlan(true)}>
              Show plan
            </button>
          </p>
          {launchedLines.length > 0 && (
            <LineChips
              lines={launchedLines.map((line, index) => ({
                id: line.id,
                name: line.name,
                color: color(index),
              }))}
              openTrain={openTrain}
            />
          )}
        </>
      ) : (
        <>
          <Prose text={proposal.summary} />
          <section
            className="plan-card"
            aria-label={`Plan for: ${plan.goal.slice(0, 80)}`}
          >
            <header className="plan-card-head">
              <span>{shape}</span>
              <span>
                from Terminus <code>{shortCommit(plan.terminusCommit)}</code>
              </span>
              {plan.model === "fake" && (
                <span className="dmsg-tag">Offline simulation</span>
              )}
              {summary && (
                <button
                  className="dmsg-link"
                  onClick={() => setShowPlan(false)}
                >
                  Hide
                </button>
              )}
            </header>
            {issues > 0 && (
              <div ref={notes} className="plan-blockers">
                {stale && (
                  <PlanNote
                    tone="attention"
                    title="Terminus has moved since I drafted this"
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => propose(plan.goal)}
                      >
                        <RefreshCw size={14} /> Re-plan on latest
                      </Button>
                    }
                  >
                    <p>
                      The plan was written against{" "}
                      <code>{shortCommit(plan.terminusCommit)}</code>; Terminus
                      is now at{" "}
                      <code>
                        {shortCommit(snapshot.network.terminusCommit)}
                      </code>
                      .
                    </p>
                  </PlanNote>
                )}
                {blocked && (
                  <PlanNote
                    tone="attention"
                    title="This plan can’t launch as drafted"
                  >
                    <ul>
                      {assessment.errors.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                    <p>Refine the goal and I&rsquo;ll draft a fresh plan.</p>
                  </PlanNote>
                )}
              </div>
            )}
            <div className="plan-lines">
              {lines.map((line, index) => (
                <PlannedLineView
                  key={line.key}
                  line={line}
                  color={color(index)}
                  number={number(index)}
                  editable={state.status === "ready"}
                  pending={pending}
                  selectMode={(mode) => void selectMode(line.key, mode)}
                />
              ))}
            </div>
            {assessment.collisions.length > 0 && (
              <PlanNote tone="held" title="Lines that may collide">
                <ul>
                  {assessment.collisions.map((collision, index) => (
                    <li key={index}>
                      <strong>{collision.line}</strong> and{" "}
                      <strong>{collision.otherLine}</strong> both touch{" "}
                      {[...collision.paths, ...collision.contracts].map(
                        (path, i) => (
                          <span key={path}>
                            {i > 0 && ", "}
                            <code>{path}</code>
                          </span>
                        )
                      )}
                    </li>
                  ))}
                </ul>
                <p>
                  This is a forecast. Actual changes and integration checks
                  decide whether a conflict exists.
                </p>
              </PlanNote>
            )}
            <PlanFooter
              state={state}
              lines={lines.length}
              issues={issues}
              showIssues={() =>
                notes.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
              }
              pending={pending}
              launch={launch}
              retry={retry}
              refine={() => refine(plan.goal)}
              launched={launchedLines.map((line, index) => ({
                id: line.id,
                name: line.name,
                color: color(index),
              }))}
              openTrain={openTrain}
            />
          </section>
        </>
      )}
    </DispatcherMessage>
  )
}

/** A planned Line drawn the way the map draws it: a rail of Stations that
 * ends at Terminus, where its unloading choice applies. */
function PlannedLineView({
  line,
  color,
  number,
  editable,
  pending,
  selectMode,
}: {
  line: PlannedLine
  color: string
  number: number
  editable: boolean
  pending: boolean
  selectMode: (mode: UnloadMode) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const recommendation = line.unloadRecommendation
  const mode = line.unloadMode ?? recommendation?.mode ?? "auto"
  const name = (key: string) =>
    line.stations.find((s) => s.key === key)?.name ?? key
  return (
    <div className="pline" style={{ "--line": color } as CSSProperties}>
      <header className="pline-head">
        <i className="pline-badge">{number.toString().padStart(2, "0")}</i>
        <strong>{line.name}</strong>
        <span>{plural(line.stations.length, "Station")}</span>
      </header>
      <ol className="pline-stops">
        {line.stations.map((station) => {
          const expanded = open === station.key
          const kind = station.manifest.repositoryChange?.kind
          return (
            <li key={station.key} className="pstop">
              <button
                className="pstop-row"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : station.key)}
              >
                <span className="pstop-dot" aria-hidden="true" />
                <span className="pstop-name">{station.name}</span>
                {kind && (
                  <span className="pstop-kind">{changeKinds[kind]}</span>
                )}
                {expanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
              </button>
              {expanded && (
                <div className="pstop-manifest">
                  <p className="pstop-goal">{station.manifest.goal}</p>
                  <ManifestView manifest={station.manifest} name={name} />
                  <TechnicalDetails
                    facts={manifestFacts(station.manifest)}
                    summary="Files, contracts and evidence"
                  />
                </div>
              )}
            </li>
          )
        })}
        <li className="pstop pstop-terminus">
          <div className="pstop-row">
            <span className="pstop-hub" aria-hidden="true">
              T
            </span>
            <span className="pstop-name">Terminus</span>
            {!editable && (
              <span className="pstop-kind">
                {mode === "auto" ? "Auto-unload" : "Human approval"}
              </span>
            )}
          </div>
          {editable && (
            <div className="pstop-unload">
              <UnloadToggle
                mode={mode}
                disabled={pending}
                onChange={selectMode}
                line={line.name}
              />
              {recommendation && (
                <p className="pstop-reason">
                  {recommendation.mode === mode
                    ? "Why I suggest this: "
                    : `I suggested ${recommendation.mode === "auto" ? "auto-unload" : "human approval"}: `}
                  {recommendation.reason}
                </p>
              )}
            </div>
          )}
        </li>
      </ol>
    </div>
  )
}

const modes: { mode: UnloadMode; label: string; hint: string }[] = [
  {
    mode: "auto",
    label: "Auto-unload",
    hint: "Integrate as soon as Terminus checks pass",
  },
  {
    mode: "human_approval",
    label: "Human approval",
    hint: "Park the finished Train in the review yard until you approve",
  },
]

function UnloadToggle({
  mode,
  disabled,
  onChange,
  line,
}: {
  mode: UnloadMode
  disabled: boolean
  onChange: (mode: UnloadMode) => void
  line: string
}) {
  return (
    <div
      className="unload-toggle"
      role="group"
      aria-label={`Unloading at Terminus for ${line}`}
    >
      {modes.map((option) => (
        <button
          key={option.mode}
          aria-pressed={mode === option.mode}
          disabled={disabled}
          title={option.hint}
          onClick={() => mode !== option.mode && onChange(option.mode)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function PlanNote({
  tone,
  title,
  action,
  children,
}: {
  tone: "attention" | "held"
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`plan-note plan-note-${tone}`} role="note">
      <h4>
        {tone === "attention" ? (
          <CircleAlert size={14} />
        ) : (
          <GitCompareArrows size={14} />
        )}
        {title}
      </h4>
      {children}
      {action && <div className="plan-note-action">{action}</div>}
    </div>
  )
}

type LineChip = { id: string; name: string; color: string }

function LineChips({
  lines,
  openTrain,
}: {
  lines: LineChip[]
  openTrain: (lineId: string) => void
}) {
  return (
    <ul className="line-chips">
      {lines.map((line) => (
        <li key={line.id}>
          <button
            onClick={() => openTrain(line.id)}
            style={{ "--line": line.color } as CSSProperties}
            title={`Open the ${line.name} Train`}
          >
            <i aria-hidden="true" />
            {line.name}
          </button>
        </li>
      ))}
    </ul>
  )
}

function PlanFooter({
  state,
  lines,
  issues,
  showIssues,
  pending,
  launch,
  retry,
  refine,
  launched,
  openTrain,
}: {
  state: Reviewed
  lines: number
  issues: number
  showIssues: () => void
  pending: boolean
  launch: () => Promise<void>
  retry: () => Promise<void>
  refine: () => void
  launched: LineChip[]
  openTrain: (lineId: string) => void
}) {
  if (state.status === "ready")
    return (
      <footer className="plan-footer plan-footer-sticky">
        <div className="plan-footer-actions">
          <Button
            disabled={pending || issues > 0}
            onClick={() => void launch()}
          >
            <TrainFront size={16} />
            {pending
              ? "Launching…"
              : `Launch ${lines === 1 ? "Line" : `${lines} Lines`}`}
          </Button>
          <Button variant="ghost" onClick={refine}>
            <PencilLine size={14} /> Refine goal
          </Button>
        </div>
        {issues > 0 ? (
          <p className="plan-footer-issues">
            {plural(issues, "issue")} to resolve before launch ·{" "}
            <button className="dmsg-link" onClick={showIssues}>
              Show
            </button>
          </p>
        ) : (
          <p>Nothing runs until you launch. Trains depart straight away.</p>
        )}
      </footer>
    )
  if (state.status === "launching" || state.status === "starting")
    return (
      <footer className="plan-footer">
        <p className="dmsg-status" role="status">
          <LoaderCircle size={14} className="spin" />
          {state.status === "launching"
            ? "Laying Lines on the map…"
            : "Starting Trains at their depots…"}
        </p>
        <button
          className="dmsg-link"
          disabled={pending}
          onClick={() => void retry()}
        >
          Stuck? Recover the launch
        </button>
      </footer>
    )
  return (
    <footer className="plan-footer">
      <p>
        {plural("trainIds" in state ? state.trainIds.length : 0, "Train")}{" "}
        departed. Follow them on the map, or open one:
      </p>
      <LineChips lines={launched} openTrain={openTrain} />
    </footer>
  )
}
