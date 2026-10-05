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
  key: string
  name: string
  /** Absent only on legacy persisted proposals. */
  unloadRecommendation?: import("./unload-policy").UnloadRecommendation
  /** User selection; recommendation remains inspectable. */
  unloadMode?: import("./unload-policy").UnloadMode
  route?: import("./crossing").PlannedStop[]
  stations: { key: string; name: string; manifest: WorkManifest }[]
}

export interface DispatchProposal {
  summary: string
  lines: PlannedLine[]
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
  validationNames: string[]
  lines?: Line[]
  stations?: Station[]
  crossings?: import("./crossing").Crossing[]
  activeLines: { name: string; manifests: WorkManifest[] }[]
}

interface ReviewedPlan {
  proposal: DispatchProposal
  assessment: PlanAssessment
}

export interface DispatchPlan {
  id: string
  networkId: string
  goal: string
  terminusCommit: string
  model: string
  createdAt: string
  state:
    | { status: "planning" }
    | ({ status: "ready" | "launching" } & ReviewedPlan)
    | ({
        status: "starting" | "launched"
        lineIds: string[]
        trainIds: string[]
      } & ReviewedPlan)
    | { status: "failed"; message: string }
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
        if (!seen.has(dependency) && !line.route)
          errors.push(
            `${label}: dependency ${dependency} must be an earlier Station on the same Line${plannedKeys.has(dependency) ? "" : " (unknown key)"}.`
          )
      }
      seen.add(station.key)
      for (const name of station.manifest.expectedEvidence) {
        if (!context.validationNames.includes(name))
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
  return { errors: [...new Set(errors)], collisions }
}

function pathsOverlap(a: string, b: string): boolean {
  a = a.replace(/\/$/, "")
  b = b.replace(/\/$/, "")
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export function readyDispatchPlan(
  plan: DispatchPlan,
  proposal: DispatchProposal,
  context: PlanningContext
): Transition<DispatchPlan> {
  if (plan.state.status !== "planning")
    return reject("invalid_state", "Plan is not being prepared")
  return accept(
    {
      ...plan,
      state: {
        status: "ready",
        proposal,
        assessment: assessDispatchProposal(proposal, context),
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
  const assessment = assessDispatchProposal(plan.state.proposal, context)
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
  if (
    lineIds.length !== plan.state.proposal.lines.length ||
    trainIds.length !== lineIds.length
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
  const line = plan.state.proposal.lines.find((line) => line.key === lineKey)
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
