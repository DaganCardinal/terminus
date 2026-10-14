import {
  lineStops,
  resolveLineRoute,
  validateCrossingTopology,
} from "./crossing"
import type { Line } from "./line"
import type { Station } from "./station"
import { hasConcreteRepositoryChange, type WorkManifest } from "./manifest"
import { accept, reject, type Transition } from "./transition"

export interface PlannedLine {
  origin?: import("./junction").LineOrigin
  destination?: import("./junction").LineDestination
  key: string
  name: string
  /** Absent only on legacy persisted proposals. */
  unloadRecommendation?: import("./unload-policy").UnloadRecommendation
  /** User selection; recommendation remains inspectable. */
  unloadMode?: import("./unload-policy").UnloadMode
  route?: import("./crossing").PlannedStop[]
  stations: { key: string; name: string; manifest: WorkManifest }[]
}

export interface PlannedJunction {
  key: string
  name: string
  brief: import("./junction").FeatureBrief
  incoming: {
    name: string
    stations: PlannedLine["stations"]
    route?: PlannedLine["route"]
  }[]
  outgoing: {
    name: string
    stations: PlannedLine["stations"]
    route?: PlannedLine["route"]
    unloadMode?: import("./unload-policy").UnloadMode
  }
}
/** A fact the Dispatcher established while exploring; never file contents. */
export interface PlanningFinding {
  topic: string
  summary: string
  paths: string[]
}

export type BaselineFixSelection = "include" | "reject"

/** A suggested Line that repairs failing baseline checks before planned work. */
export interface BaselineFix {
  reason: string
  line: PlannedLine
  /** User selection; absent means include. */
  selection?: BaselineFixSelection
}

export interface DispatchProposal {
  junctions?: PlannedJunction[]
  summary: string
  lines: PlannedLine[]
  findings?: PlanningFinding[]
  baselineFix?: BaselineFix
}

/** Trusted checks orchestration ran on the planning baseline before the Dispatcher explored it. */
export interface BaselineReport {
  commit: string
  checks: {
    name: string
    status: "passed" | "failed" | "skipped"
    exitCode?: number
    outputTail: string
    outputTruncated: boolean
  }[]
}

export interface CollisionForecast {
  line: string
  otherLine: string
  paths: string[]
  contracts: string[]
}

export interface PlanAssessment {
  errors: string[]
  collisions: CollisionForecast[]
}

export interface PlanningContext {
  /** The project's configured checks. Their names are the evidence a Station
   * may request, and every converged Junction feature runs them, so a feature
   * check may reuse a name only with its command. */
  projectChecks: { name: string; command: string[] }[]
  lines?: Line[]
  stations?: Station[]
  junctions?: import("./junction").Junction[]
  crossings?: import("./crossing").Crossing[]
  activeLines: { name: string; manifests: WorkManifest[] }[]
  /** Lines whose work has reached Terminus or was abandoned, most recently
   * finished first. Plan checks still use every Line and Station; the
   * Dispatcher prompt summarizes these instead of sending them in full. */
  finishedLines?: { lineId: string; outcome: "integrated" | "abandoned" }[]
}

interface ReviewedPlan {
  proposal: DispatchProposal
  assessment: PlanAssessment
  /** Present when the user asked for a baseline check before planning. */
  baseline?: BaselineReport
}

export interface DispatchPlan {
  id: string
  networkId: string
  goal: string
  terminusCommit: string
  model: string
  agent?: import("./car").AgentConfig
  createdAt: string
  /** Install dependencies and run project checks on the baseline before exploring. */
  checkBaseline?: boolean
  state:
    | { status: "planning" }
    | ({ status: "ready" | "launching" } & ReviewedPlan)
    | ({
        status: "starting" | "launched"
        lineIds: string[]
        trainIds: string[]
      } & ReviewedPlan)
    | {
        status: "failed"
        message: string
        reason?: "cancelled"
        cleanupPending?: boolean
      }
}

export function createDispatchPlan(
  input: Omit<DispatchPlan, "state">
): Transition<DispatchPlan> {
  if (!input.goal.trim()) return reject("invalid_input", "A plan needs a goal")
  return accept({ ...input, state: { status: "planning" } }, [
    { type: "dispatcher.plan_requested", planId: input.id },
  ])
}

/** Declared collisions are forecasts, never unresolved Git conflicts. */
export function assessDispatchProposal(
  proposal: DispatchProposal,
  context: PlanningContext
): PlanAssessment {
  const errors: string[] = []
  if (proposal.junctions?.length) {
    const keys = proposal.junctions.map((j) => j.key)
    if (new Set(keys).size !== keys.length)
      errors.push("Junction keys must be unique")
    const expanded: DispatchProposal = {
      summary: proposal.summary,
      lines: [...proposal.lines],
    }
    for (const j of proposal.junctions) {
      if (j.incoming.length < 2)
        errors.push("A Junction needs at least two incoming Lines")
      for (const check of j.brief.validation) {
        const project = context.projectChecks.find((c) => c.name === check.name)
        if (
          project &&
          JSON.stringify(project.command) !== JSON.stringify(check.command)
        )
          errors.push(
            `${j.name}: feature check ${check.name} conflicts with the project check of that name (${project.command.join(" ")}). Project checks already run on the feature; remove it or give it a different name.`
          )
      }
      expanded.lines.push(
        ...j.incoming.map((l, i) => ({
          ...l,
          key: `${j.key}-l${i}`,
          destination: { kind: "junction" as const, junctionId: j.key },
        })),
        {
          ...j.outgoing,
          key: `${j.key}-outgoing`,
          origin: { kind: "junction" as const, junctionId: j.key },
        }
      )
    }
    const assessed = assessDispatchProposal(expanded, context)
    return {
      ...assessed,
      errors: [...new Set([...errors, ...assessed.errors])],
    }
  }
  if (!proposal.lines.length)
    errors.push("A plan needs at least one Line or Junction")
  const collisions: CollisionForecast[] = []
  let resolvedLines: Line[] = context.lines ?? []
  let resolvedStations: Station[] = context.stations ?? []
  const lineKeys = new Set<string>()
  const stationKeys = new Set<string>()
  const plannedKeys = new Set(
    proposal.lines.flatMap((l) => l.stations.map((s) => s.key))
  )
  for (const line of proposal.lines) {
    if (lineKeys.has(line.key)) errors.push(`Duplicate Line key: ${line.key}`)
    lineKeys.add(line.key)
    const seen = new Set<string>()
    for (const station of line.stations) {
      const label = `${line.name} / ${station.name}`
      if (!hasConcreteRepositoryChange(station.manifest))
        errors.push(
          `${label}: declare a concrete repository change; verification-only Stations are not supported.`
        )
      if (stationKeys.has(station.key))
        errors.push(`Duplicate Station key: ${station.key}`)
      stationKeys.add(station.key)
      for (const dependency of station.manifest.dependencies) {
        if (
          !seen.has(dependency) &&
          !line.route &&
          !(
            line.origin?.kind === "junction" &&
            proposal.lines.some(
              (l) =>
                l.destination?.kind === "junction" &&
                l.destination.junctionId ===
                  (line.origin as { kind: "junction"; junctionId: string })
                    .junctionId &&
                l.stations.some((s) => s.key === dependency)
            )
          )
        )
          errors.push(
            `${label}: dependency ${dependency} must be an earlier Station on the same Line${plannedKeys.has(dependency) ? "" : " (unknown key)"}.`
          )
      }
      seen.add(station.key)
      for (const name of station.manifest.expectedEvidence) {
        if (!context.projectChecks.some((check) => check.name === name))
          errors.push(
            `${label}: evidence ${name} is not a configured project check.`
          )
      }
      for (const path of station.manifest.expectedAreas) {
        if (
          station.manifest.avoidAreas.some((avoid) => pathsOverlap(path, avoid))
        )
          errors.push(
            `${label}: expected area ${path} overlaps an avoided area.`
          )
      }
    }
  }
  try {
    const keys = new Map(
      proposal.lines.flatMap((l) =>
        l.stations.map((s) => [s.key, s.key] as const)
      )
    )
    const stations: Station[] = proposal.lines.flatMap((l) =>
      l.stations.map((s) => ({
        id: s.key,
        lineId: l.key,
        name: s.name,
        manifest: s.manifest,
        revisionCount: 0,
        state: { status: "waiting" as const },
      }))
    )
    const lines = proposal.lines.map(
      (l) =>
        resolveLineRoute(
          {
            id: l.key,
            networkId: context.lines?.[0]?.networkId ?? "plan",
            name: l.name,
            ...(l.origin ? { origin: l.origin } : {}),
            ...(l.destination ? { destination: l.destination } : {}),
            stationIds: l.stations.map((s) => s.key),
          },
          l.route,
          keys
        ).line
    )
    resolvedLines = [...(context.lines ?? []), ...lines]
    resolvedStations = [...(context.stations ?? []), ...stations]
    errors.push(...validateCrossingTopology(resolvedLines, resolvedStations))
    for (const s of stations)
      for (const dep of s.manifest.dependencies)
        if (
          !stations.some((v) => v.id === dep) &&
          !context.stations?.some((v) => v.id === dep)
        )
          errors.push(`Unknown dependency ${dep}`)
  } catch (error) {
    errors.push(String(error))
  }
  const receivesBefore = (
    consumer: WorkManifest,
    provider: WorkManifest
  ): boolean => {
    const station = resolvedStations.find((s) => s.manifest === consumer)
    const line = resolvedLines.find((l) => l.id === station?.lineId)
    if (!station || !line) return false
    const providerStation = resolvedStations.find(
      (s) => s.manifest === provider
    )
    const providerLine = resolvedLines.find(
      (l) => l.id === providerStation?.lineId
    )
    if (
      line.origin?.kind === "junction" &&
      providerLine?.destination?.kind === "junction" &&
      line.origin.junctionId === providerLine.destination.junctionId
    )
      return true
    const includesProvider = (
      checkpointId: string,
      seen = new Set<string>()
    ): boolean => {
      if (seen.has(checkpointId)) return false
      seen.add(checkpointId)
      const source = resolvedStations.find((s) => s.id === checkpointId)
      const owner = resolvedLines.find((l) => l.id === source?.lineId)
      if (!owner) return false
      for (const stop of lineStops(owner)) {
        if (stop.kind === "crossing") {
          if (includesProvider(stop.stationId, seen)) return true
        } else {
          if (
            resolvedStations.find((s) => s.id === stop.stationId)?.manifest ===
            provider
          )
            return true
          if (stop.stationId === checkpointId) break
        }
      }
      return false
    }
    for (const stop of lineStops(line)) {
      if (stop.kind === "station" && stop.stationId === station.id) break
      if (stop.kind === "crossing" && includesProvider(stop.stationId))
        return true
    }
    return false
  }
  const planned = proposal.lines.map((line) => ({
    name: line.name,
    manifests: line.stations.map((s) => s.manifest),
  }))
  for (let i = 0; i < planned.length; i++) {
    const left = planned[i]!
    for (const right of [...planned.slice(i + 1), ...context.activeLines]) {
      const paths = [
        ...new Set(
          left.manifests
            .flatMap((m) => m.expectedAreas)
            .filter((path) =>
              right.manifests.some((m) =>
                m.expectedAreas.some((other) => pathsOverlap(path, other))
              )
            )
        ),
      ]
      const contracts: string[] = []
      for (const am of left.manifests)
        for (const bm of right.manifests) {
          for (const a of am.contracts)
            for (const b of bm.contracts) {
              if (
                a.name !== b.name ||
                a.kind !== b.kind ||
                (a.change === "depends_on" && b.change === "depends_on")
              )
                continue
              contracts.push(`${a.kind}: ${a.name}`)
              if (
                (a.change === "depends_on" && !receivesBefore(am, bm)) ||
                (b.change === "depends_on" && !receivesBefore(bm, am))
              )
                errors.push(
                  `${left.name} and ${right.name} share a code dependency on ${a.name}; keep dependent work on one Line or pick up its accepted checkpoint before the consumer.`
                )
            }
        }
      if (paths.length || contracts.length)
        collisions.push({
          line: left.name,
          otherLine: right.name,
          paths,
          contracts: [...new Set(contracts)],
        })
    }
  }
  return {
    errors: [...new Set(errors)],
    collisions,
  }
}

export function pathsOverlap(a: string, b: string): boolean {
  a = a.replace(/\/$/, "")
  b = b.replace(/\/$/, "")
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export function baselineFailed(report: BaselineReport | undefined): boolean {
  return !!report?.checks.some((check) => check.status !== "passed")
}

/**
 * The proposal that launches. An included baseline fix becomes its own Line,
 * and every other top-level Line picks up its accepted checkpoint through a
 * Crossing before its first Station.
 */
export function launchProposal(proposal: DispatchProposal): DispatchProposal {
  const { baselineFix, ...base } = proposal
  if (!baselineFix || baselineFix.selection === "reject") return base
  const fix = baselineFix.line.stations[0]
  if (!fix) return base
  return {
    ...base,
    lines: [
      baselineFix.line,
      ...base.lines.map((line) => ({
        ...line,
        route: [
          {
            kind: "crossing" as const,
            source: { kind: "planned" as const, stationKey: fix.key },
          },
          ...(line.route ??
            line.stations.map((s) => ({
              kind: "station" as const,
              key: s.key,
            }))),
        ],
      })),
    ],
  }
}

/** Assesses what would launch, including baseline-fix rules. */
export function assessPlan(
  proposal: DispatchProposal,
  context: PlanningContext,
  baseline: BaselineReport | undefined
): PlanAssessment {
  const assessment = assessDispatchProposal(launchProposal(proposal), context)
  const errors: string[] = []
  const fix = proposal.baselineFix
  if (fix) {
    if (!baselineFailed(baseline))
      errors.push(
        "A baseline fix was proposed, but the baseline checks did not fail."
      )
    if (fix.line.stations.length !== 1 || fix.line.route)
      errors.push("A baseline fix must be one Line with exactly one Station.")
    if (fix.selection !== "reject" && proposal.junctions?.length)
      errors.push(
        "A baseline fix cannot reach Junction input Lines; reject the fix or request a plan without Junctions."
      )
  }
  return {
    ...assessment,
    errors: [...new Set([...errors, ...assessment.errors])],
  }
}

export function readyDispatchPlan(
  plan: DispatchPlan,
  proposal: DispatchProposal,
  context: PlanningContext,
  baseline?: BaselineReport
): Transition<DispatchPlan> {
  if (plan.state.status !== "planning")
    return reject("invalid_state", "Plan is not being prepared")
  return accept(
    {
      ...plan,
      state: {
        status: "ready",
        proposal,
        assessment: assessPlan(proposal, context, baseline),
        ...(baseline ? { baseline } : {}),
      },
    },
    [{ type: "dispatcher.plan_ready", planId: plan.id }]
  )
}

export function requestPlanLaunch(
  plan: DispatchPlan,
  currentCommit: string,
  context: PlanningContext
): Transition<DispatchPlan> {
  if (plan.state.status !== "ready")
    return reject("invalid_state", "Plan is not ready to launch")
  if (plan.terminusCommit !== currentCommit)
    return reject(
      "invalid_input",
      "Terminus changed; request a fresh plan before launching"
    )
  const assessment = assessPlan(
    plan.state.proposal,
    context,
    plan.state.baseline
  )
  if (assessment.errors.length)
    return reject("invalid_input", assessment.errors.join(" "))
  if (hasNewCollisionForecasts(plan.state.assessment, assessment))
    return reject(
      "invalid_input",
      "New collision forecasts appeared since review; request a fresh plan"
    )
  return accept(
    { ...plan, state: { ...plan.state, status: "launching", assessment } },
    [{ type: "dispatcher.launch_requested", planId: plan.id }]
  )
}

export function launchDispatchPlan(
  plan: DispatchPlan,
  lineIds: string[],
  trainIds: string[]
): Transition<DispatchPlan> {
  if (plan.state.status !== "launching")
    return reject("invalid_state", "Plan launch was not requested")
  const proposal = launchProposal(plan.state.proposal)
  if (
    lineIds.length !==
      proposal.lines.length +
        (proposal.junctions ?? []).reduce(
          (n, j) => n + j.incoming.length + 1,
          0
        ) ||
    trainIds.length !==
      proposal.lines.length +
        (proposal.junctions ?? []).reduce((n, j) => n + j.incoming.length, 0)
  )
    return reject("invalid_input", "Every planned Line must have one Train")
  return accept(
    {
      ...plan,
      state: { ...plan.state, status: "starting", lineIds, trainIds },
    },
    [{ type: "dispatcher.lines_laid", planId: plan.id, lineIds, trainIds }]
  )
}

export function finishPlanLaunch(plan: DispatchPlan): Transition<DispatchPlan> {
  if (plan.state.status !== "starting")
    return reject("invalid_state", "Plan has no Trains to start")
  return accept({ ...plan, state: { ...plan.state, status: "launched" } }, [
    {
      type: "dispatcher.plan_launched",
      planId: plan.id,
      lineIds: plan.state.lineIds,
      trainIds: plan.state.trainIds,
    },
  ])
}

/** User cancellation uses the existing terminal storage status, with an explicit reason. */
export function cancelDispatchPlan(
  plan: DispatchPlan
): Transition<DispatchPlan> {
  if (plan.state.status === "failed" && plan.state.reason === "cancelled")
    return accept(plan, [])
  if (plan.state.status !== "planning")
    return reject("invalid_state", "Only a plan being prepared can be stopped")
  return accept(
    {
      ...plan,
      state: {
        status: "failed",
        reason: "cancelled",
        cleanupPending: true,
        message: "Planning stopped at your request.",
      },
    },
    [{ type: "dispatcher.plan_cancelled", planId: plan.id }]
  )
}

/** Resource cleanup completes separately from the durable cancellation fence. */
export function finishDispatchCancellation(
  plan: DispatchPlan
): Transition<DispatchPlan> {
  if (plan.state.status !== "failed" || plan.state.reason !== "cancelled")
    return reject("invalid_state", "Plan was not cancelled")
  if (!plan.state.cleanupPending) return accept(plan, [])
  return accept({ ...plan, state: { ...plan.state, cleanupPending: false } }, [
    { type: "dispatcher.plan_stopped", planId: plan.id },
  ])
}

export function failDispatchPlan(
  plan: DispatchPlan,
  message: string
): Transition<DispatchPlan> {
  if (plan.state.status !== "planning" && plan.state.status !== "launching")
    return reject("invalid_state", "Plan cannot fail in its current state")
  return accept({ ...plan, state: { status: "failed", message } }, [
    { type: "dispatcher.plan_failed", planId: plan.id },
  ])
}

export function hasNewCollisionForecasts(
  reviewed: PlanAssessment,
  current: PlanAssessment
): boolean {
  return current.collisions.some(
    (collision) =>
      !reviewed.collisions.some(
        (previous) => JSON.stringify(previous) === JSON.stringify(collision)
      )
  )
}

/** Changes only the selected policy on a reviewable proposal. */
export function selectPlannedUnloadMode(
  plan: DispatchPlan,
  lineKey: string,
  mode: import("./unload-policy").UnloadMode
): Transition<DispatchPlan> {
  if (plan.state.status !== "ready")
    return reject("invalid_state", "Unload selections require a ready proposal")
  const fix = plan.state.proposal.baselineFix
  if (fix?.line.key === lineKey) {
    if (fix.line.unloadMode === mode) return accept(plan, [])
    return accept(
      {
        ...plan,
        state: {
          ...plan.state,
          proposal: {
            ...plan.state.proposal,
            baselineFix: { ...fix, line: { ...fix.line, unloadMode: mode } },
          },
        },
      },
      [
        {
          type: "dispatcher.unload_mode_changed",
          planId: plan.id,
          lineKey,
          mode,
        },
      ]
    )
  }
  const line = plan.state.proposal.lines.find((line) => line.key === lineKey)
  if (!line) {
    const junction = plan.state.proposal.junctions?.find(
      (j) => `${j.key}-outgoing` === lineKey
    )
    if (!junction) return reject("invalid_input", "Unknown planned Line")
    if (junction.outgoing.unloadMode === mode) return accept(plan, [])
    return accept(
      {
        ...plan,
        state: {
          ...plan.state,
          proposal: {
            ...plan.state.proposal,
            junctions: plan.state.proposal.junctions!.map((j) =>
              j.key === junction.key
                ? { ...j, outgoing: { ...j.outgoing, unloadMode: mode } }
                : j
            ),
          },
        },
      },
      [
        {
          type: "dispatcher.unload_mode_changed",
          planId: plan.id,
          lineKey,
          mode,
        },
      ]
    )
  }
  if (!line) return reject("invalid_input", "Unknown planned Line")
  if (line.unloadMode === mode) return accept(plan, [])
  return accept(
    {
      ...plan,
      state: {
        ...plan.state,
        proposal: {
          ...plan.state.proposal,
          lines: plan.state.proposal.lines.map((line) =>
            line.key === lineKey ? { ...line, unloadMode: mode } : line
          ),
        },
      },
    },
    [{ type: "dispatcher.unload_mode_changed", planId: plan.id, lineKey, mode }]
  )
}

/** Includes or rejects the suggested baseline fix on a reviewable proposal. */
export function selectBaselineFix(
  plan: DispatchPlan,
  selection: BaselineFixSelection,
  context: PlanningContext
): Transition<DispatchPlan> {
  if (plan.state.status !== "ready")
    return reject(
      "invalid_state",
      "Baseline fix selections require a ready proposal"
    )
  const fix = plan.state.proposal.baselineFix
  if (!fix) return reject("invalid_input", "This plan has no baseline fix")
  if ((fix.selection ?? "include") === selection) return accept(plan, [])
  const proposal = {
    ...plan.state.proposal,
    baselineFix: { ...fix, selection },
  }
  return accept(
    {
      ...plan,
      state: {
        ...plan.state,
        proposal,
        assessment: assessPlan(proposal, context, plan.state.baseline),
      },
    },
    [{ type: "dispatcher.baseline_fix_selected", planId: plan.id, selection }]
  )
}
