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
import {
  lineIdentities,
  type DispatchPlan,
  type NetworkSnapshot,
  type UnloadMode,
} from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { lineBadge, lineColor } from "@/map/layout"
import { crossingScope } from "./crossing-scope"
import { UnloadModeSwitch } from "./unload-mode-switch"
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
          selectFix={(selection) =>
            command(() =>
              api.selectPlanBaselineFix(networkId, plan.id, selection)
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

/** The Dispatcher is exploring the project and writing manifests. Elapsed
 * time is real; nothing here pretends to measure progress. */
const recoverAfterSeconds = 35 * 60

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
          {plan.checkBaseline
            ? "Checking the baseline, then exploring"
            : "Exploring"}{" "}
          the project at <code>{shortCommit(plan.terminusCommit)}</code> and
          drafting Lines and Station manifests
        </span>
      </p>
      <p className="dmsg-hint">
        <span className="tabular">{elapsed}</span> · The proposal is saved when
        it&rsquo;s ready, so you can close this panel.
      </p>
      {/* Recovery only restarts an errored run, so offer it once the
          planning step's own time budget has passed. */}
      {seconds > recoverAfterSeconds && (
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
  selectFix,
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
  selectFix: (selection: "include" | "reject") => Promise<void>
  retry: () => Promise<void>
  refine: (goal: string) => void
  propose: (goal: string) => void
  openTrain: (lineId: string) => void
}) {
  const { proposal, assessment } = state
  const launched = state.status === "launched"
  // Older and launched plans fold to a summary so the thread stays readable.
  const [showPlan, setShowPlan] = useState(latest && !launched)
  const fix = proposal.baselineFix
  const fixIncluded = !!fix && fix.selection !== "reject"
  // Matches launch order: an included fix is laid first, and every other
  // Line picks up its accepted checkpoint before its first Station.
  const lines = fixIncluded ? [fix.line, ...proposal.lines] : proposal.lines
  const stations = lines.reduce((n, line) => n + line.stations.length, 0)
  const lineIds = "lineIds" in state ? state.lineIds : []
  const launchedLines = lineIds
    .map((id) => snapshot.lines.find((line) => line.id === id))
    .filter((line) => line !== undefined)
  // Planned Lines are laid after every existing Line, so they take the
  // slots and colours that are free now, including those finished Lines left.
  const predicted = lineIdentities(
    snapshot,
    lines.map((line, index) => ({ id: `planned-${index}`, name: line.name }))
  )
  const badge = (index: number) => {
    const line = launchedLines[index]
    if (line) return lineBadge(snapshot, line.id)!
    const identity = predicted.get(`planned-${index}`)!
    return { number: identity.slot + 1, color: lineColor(identity.color) }
  }
  const color = (index: number) => badge(index).color
  const number = (index: number) => badge(index).number
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
          {(proposal.junctions ?? []).map((j) => (
            <details className="plan-card" key={j.key}>
              <summary>
                {j.name} · Junction · {j.incoming.length} incoming Lines
              </summary>
              <p>{j.brief.goal}</p>
              <p>
                Frozen baseline {shortCommit(plan.terminusCommit)}. All inputs
                must be accepted; human approval releases the complete feature.
              </p>
              <ul>
                {j.incoming.map((l, i) => (
                  <li key={i}>
                    {l.name}: {l.stations.map((s) => s.name).join(" → ")} →{" "}
                    {j.name}
                    {l.route?.some((s) => s.kind === "crossing")
                      ? " · internal Crossings"
                      : ""}
                  </li>
                ))}
              </ul>
              <p>
                {j.name} → {j.outgoing.stations.map((s) => s.name).join(" → ")}
                {j.outgoing.stations.length ? " → " : ""}Terminus
              </p>
              <UnloadModeSwitch
                mode={j.outgoing.unloadMode ?? "auto"}
                disabled={pending || state.status !== "ready"}
                onChange={(mode) => void selectMode(`${j.key}-outgoing`, mode)}
              />
              <ul>
                {j.brief.acceptanceCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <details>
                <summary>Feature checks and manifests</summary>
                <pre className="unload-diff">
                  {JSON.stringify(
                    {
                      brief: j.brief,
                      incoming: j.incoming,
                      outgoing: j.outgoing,
                    },
                    null,
                    2
                  )}
                </pre>
              </details>
            </details>
          ))}
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
            {state.baseline && (
              <BaselineNote
                baseline={state.baseline}
                fix={fix}
                editable={state.status === "ready"}
                pending={pending}
                selectFix={selectFix}
              />
            )}
            {lines.some((l) => l.route?.some((s) => s.kind === "crossing")) && (
              <PlanNote tone="held" title="Crossing routes">
                {lines.map((l) => (
                  <p key={l.key}>
                    <strong>{l.name}:</strong>{" "}
                    {(
                      l.route ??
                      l.stations.map((s) => ({
                        kind: "station" as const,
                        key: s.key,
                      }))
                    )
                      .map((stop) =>
                        stop.kind === "station"
                          ? (l.stations.find((s) => s.key === stop.key)?.name ??
                            stop.key)
                          : (() => {
                              const inherited = crossingScope(
                                lines,
                                snapshot,
                                stop.source
                              )
                              return `Pickup at ${inherited.station} (${inherited.line} → ${l.name}; inherited scope: ${inherited.areas.join(", ") || "not specified"})`
                            })()
                      )
                      .join(" → ")}
                    . Pickups include all accepted Cars through the source
                    Station.
                  </p>
                ))}
              </PlanNote>
            )}
            {proposal.findings && proposal.findings.length > 0 && (
              <Findings findings={proposal.findings} />
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

type Finding = NonNullable<Reviewed["proposal"]["findings"]>[number]

/** What exploration established, with the paths that support each fact. */
function Findings({ findings }: { findings: Finding[] }) {
  return (
    <details className="plan-findings">
      <summary>
        What Dispatch explored · {plural(findings.length, "finding")}
      </summary>
      <ul>
        {findings.map((finding, index) => (
          <li key={index}>
            <strong>{finding.topic}</strong>
            <p>{finding.summary}</p>
            {finding.paths.length > 0 && (
              <p className="plan-finding-paths">
                {finding.paths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

type Baseline = NonNullable<Reviewed["baseline"]>

/** Trusted checks on the planning baseline, and the suggested fix when one failed. */
function BaselineNote({
  baseline,
  fix,
  editable,
  pending,
  selectFix,
}: {
  baseline: Baseline
  fix: Reviewed["proposal"]["baselineFix"]
  editable: boolean
  pending: boolean
  selectFix: (selection: "include" | "reject") => Promise<void>
}) {
  const failed = baseline.checks.filter((check) => check.status !== "passed")
  if (!failed.length)
    return (
      <PlanNote tone="held" title="Baseline checks passed">
        <p>
          {baseline.checks.map((check) => check.name).join(", ")} passed on{" "}
          <code>{shortCommit(baseline.commit)}</code> before planning.
        </p>
      </PlanNote>
    )
  const included = !!fix && fix.selection !== "reject"
  return (
    <PlanNote
      tone="attention"
      title={`Baseline checks failing: ${failed.map((c) => c.name).join(", ")}`}
      action={
        fix && editable ? (
          <div
            className="plan-fix-choice"
            role="group"
            aria-label="Baseline fix"
          >
            <Button
              size="sm"
              variant={included ? "default" : "outline"}
              aria-pressed={included}
              disabled={pending || included}
              onClick={() => void selectFix("include")}
            >
              Include fix
            </Button>
            <Button
              size="sm"
              variant={included ? "outline" : "default"}
              aria-pressed={!included}
              disabled={pending || !included}
              onClick={() => void selectFix("reject")}
            >
              Reject fix
            </Button>
          </div>
        ) : undefined
      }
    >
      <p>
        Every Station must pass every check, so these failures would return
        every Station&rsquo;s work.
      </p>
      {failed.map((check) => (
        <details key={check.name}>
          <summary>
            {check.name} {check.status}
            {check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}
          </summary>
          <pre className="unload-diff">
            {check.outputTruncated ? "…" : ""}
            {check.outputTail}
          </pre>
        </details>
      ))}
      {fix ? (
        <p>
          {fix.reason}{" "}
          {included
            ? `${fix.line.name} runs first; every other Line picks up its accepted fix before its first Station.`
            : "The fix is rejected; Lines start from the failing baseline."}
        </p>
      ) : (
        <p>The Dispatcher did not suggest a separate fix for this goal.</p>
      )}
    </PlanNote>
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
            ? "Laying tracks…"
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
