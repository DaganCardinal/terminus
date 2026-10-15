import {
  reasoningLevelSchema,
  type DomainEvent,
  type HoldReason,
  type Issue,
  type NetworkSnapshot,
  type ReasoningLevel,
  type Station,
  type TrainState,
} from "@terminus/protocol"

export const reasoningNames: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

/** A model with the reasoning level it ran at, when its provenance records one. */
export function modelWithReasoning(agent: {
  model: string
  reasoning?: string
}): string {
  if (!agent.reasoning) return agent.model
  const level = reasoningLevelSchema.safeParse(agent.reasoning)
  return `${agent.model} (${level.success ? reasoningNames[level.data] : agent.reasoning} reasoning)`
}

/** A status as words. A returning Train reads as approaching its destination,
 * which is how it looks on the map. */
export const statusWords = (status: string) =>
  status === "returning" ? "approaching" : status.replaceAll("_", " ")

/** Show what a docked Train is waiting on, using its Station's current state. */
export function trainDisplayStatus(
  state: TrainState,
  stations: readonly Pick<Station, "id" | "state">[]
): TrainState["status"] | "revising" {
  return state.status === "docked" &&
    !state.crossingId &&
    stations.some(
      (station) =>
        station.id === state.at && station.state.status === "revising"
    )
    ? "revising"
    : state.status
}

/** Display names for the ids in a snapshot. */
export function namesFor(snapshot: NetworkSnapshot): (id: string) => string {
  const names = new Map<string, string>()
  for (const j of snapshot.junctions ?? []) names.set(j.id, j.name)
  for (const line of snapshot.lines) names.set(line.id, line.name)
  for (const station of snapshot.stations) names.set(station.id, station.name)
  for (const { train } of snapshot.trains) {
    names.set(train.id, `${names.get(train.lineId) ?? "Unknown"} Train`)
  }
  return (id) => names.get(id) ?? id
}

export function describeLocation(
  state: TrainState,
  name: (id: string) => string,
  destination?: import("@terminus/protocol").Train["destination"],
  stations: readonly Pick<Station, "id" | "state">[] = []
): string {
  switch (state.status) {
    case "ready":
      return state.at.kind === "depot"
        ? "At the depot"
        : state.at.kind === "junction"
          ? `At ${name(state.at.junctionId)}`
          : `At ${name(state.at.stationId)}`
    case "in_transit":
      return `Working toward ${name(state.toward)}`
    case "approaching":
      return `Approaching ${name(state.toward)}`
    case "docked":
      return `${trainDisplayStatus(state, stations) === "revising" ? "Revising work" : "Docked"} at ${name(state.at)}`
    case "reviewing":
      return `Reviewing work at ${name(state.at)}`
    case "held":
      return `Held: ${state.reasons.map((reason) => describeHold(reason, name)).join("; ")}`
    case "blocked":
      return `Blocked: ${describeIssues(state.issues)}`
    case "returning":
      return state.phase === "integrating"
        ? `Integrating into ${destination?.kind === "junction" ? name(destination.junctionId) : "Terminus"}`
        : `Waiting for clearance into ${destination?.kind === "junction" ? name(destination.junctionId) : "Terminus"}`
    case "unloaded":
      return state.destination?.kind === "junction"
        ? `Unloaded into ${name(state.destination.junctionId)}`
        : "Unloaded into Terminus"
    case "siding":
      return `On the siding: ${state.reason}`
  }
}

export function describeEvent(
  event: DomainEvent,
  name: (id: string) => string
): string {
  if ("junctionId" in event)
    return `${name(event.junctionId)} · ${event.type.replace("junction.", "").replaceAll("_", " ")}${"issues" in event ? `: ${describeIssues(event.issues)}` : ""}`
  switch (event.type) {
    case "engineer.assessed":
      return `${name(event.trainId)} · Engineer assessed ${event.purpose.replaceAll("_", " ")}: ${event.action}`
    case "dispatcher.engineer_notice_raised":
      return event.summary
    case "dispatcher.engineer_notice_acknowledged":
      return `${name(event.trainId)} · Engineer notice acknowledged`
    case "dispatcher.engineer_notice_resolved":
      return `${name(event.trainId)} · Engineer notice resolved`
    case "dispatcher.conflict_investigating":
      return `Dispatcher checking ${name(event.trainId)} against ${name(event.otherTrainId)} for conflicts`
    case "dispatcher.conflict_reported":
      return `Possible conflict between ${name(event.trainId)} and ${name(event.otherTrainId)}: ${event.summary}`
    case "dispatcher.conflict_cleared":
      return `No conflict between ${name(event.trainId)} and ${name(event.otherTrainId)}`
    case "dispatcher.conflict_investigation_failed":
      return `Conflict check of ${name(event.trainId)} and ${name(event.otherTrainId)} could not finish`
    case "dispatcher.conflict_acknowledged":
      return `Conflict report for ${name(event.trainId)} and ${name(event.otherTrainId)} acknowledged`
    case "station.run_failed":
      return `${name(event.stationId)} run failed${event.phase ? ` during ${event.phase}` : ""}: ${describeIssues(event.issues)}`
    case "crossing.created":
      return `Crossing laid at ${name(event.stationId)}`
    case "crossing.approaching":
      return `${name(event.trainId)} approaching pickup at ${name(event.stationId)}`
    case "crossing.started":
      return `${name(event.trainId)} checking pickup at ${name(event.stationId)}`
    case "crossing.blocked":
      return `${name(event.trainId)} blocked at Crossing ${name(event.stationId)}`
    case "crossing.retried":
      return `${name(event.trainId)} retrying pickup at ${name(event.stationId)}`
    case "crossing.completed":
      return `${name(event.trainId)} picked up ${event.carIds.length} Cars at ${name(event.stationId)}`
    case "dispatcher.unload_mode_changed":
      return `Unload selection updated for planned Line ${event.lineKey}`
    case "train.unload_mode_changed":
      return `${name(event.trainId)} set to ${event.mode === "auto" ? "auto-unload" : "human approval"}`
    case "train.unload_approved":
      return `${name(event.trainId)} approved for unloading at ${event.trainCommit}`
    case "technician.integration_failed":
      return `Technician candidate stopped during integration; inspect the evidence`
    case "technician.validated":
      return `Technician candidate independently validated`
    case "technician.dispatched":
      return `Technician dispatched for ${name(event.trainId)}`
    case "technician.started":
      return `Technician repairing ${name(event.trainId)} integration`
    case "technician.candidate_prepared":
      return `Technician candidate ready for Conductor review`
    case "technician.reviewed":
      return `Conductor reviewed the Technician candidate`
    case "technician.approved":
      return `Technician repair approved for integration`
    case "technician.failed":
      return `Technician stopped; inspect the repair details`
    case "technician.integrated":
      return `Technician repair integrated into Terminus`
    case "technician.stale":
      return `Technician candidate superseded after its source moved`
    case "dispatcher.user_attention_requested":
      return `Dispatcher requests user intervention for ${name(event.stationId)}: ${describeIssues(event.issues)}`
    case "dispatcher.plan_requested":
      return "Dispatcher preparing a plan"
    case "dispatcher.plan_ready":
      return "Dispatcher proposal ready to review"
    case "dispatcher.launch_requested":
      return "Planned Lines requested for launch"
    case "dispatcher.lines_laid":
      return `Dispatcher laid ${plural(event.lineIds.length, "Line")}`
    case "dispatcher.plan_launched":
      return `Dispatcher launched ${plural(event.trainIds.length, "Train")}`
    case "dispatcher.plan_cancelled":
      return "Dispatcher planning cancelled at your request"
    case "dispatcher.plan_stopped":
      return "Dispatcher planning stopped"
    case "dispatcher.plan_failed":
      return "Dispatcher plan stopped; inspect its details"
    case "dispatcher.baseline_fix_selected":
      return event.selection === "include"
        ? "Baseline fix included in the proposal"
        : "Baseline fix rejected from the proposal"
    case "line.created":
      return `${name(event.lineId)} laid with ${plural(event.stationIds.length, "Station")}`
    case "train.created":
      return `${name(event.trainId)} created at the depot`
    case "train.departed":
      return `${name(event.trainId)} departed toward ${name(event.stationId)}`
    case "train.approaching":
      return `${name(event.trainId)} approaching ${name(event.stationId)}`
    case "train.arrived":
      return `${name(event.trainId)} arrived at ${name(event.stationId)}`
    case "train.held":
      return `${name(event.trainId)} held: ${event.reasons.map((reason) => describeHold(reason, name)).join("; ")}`
    case "train.released":
      return `${name(event.trainId)} released`
    case "train.blocked":
      return `${name(event.trainId)} blocked: ${describeIssues(event.issues)}`
    case "train.issue_raised":
      return `${name(event.trainId)} raised an issue to the Dispatcher`
    case "train.cleared":
      return `${name(event.trainId)} cleared to continue`
    case "train.returning":
      return `${name(event.trainId)} approaching Terminus`
    case "train.unloaded":
      return `${name(event.trainId)} unloaded`
    case "train.sided":
      return `${name(event.trainId)} moved to the siding`
    case "station.signaled":
      return `${name(event.stationId)} signaled`
    case "station.workspace_created":
      return `${name(event.stationId)} workspace prepared`
    case "station.started":
      return `${name(event.stationId)} Station Agent started`
    case "station.ready_for_pickup":
      return `${name(event.stationId)} ready for pickup`
    case "station.returned":
      return `${name(event.stationId)} returned: ${event.feedback.summary}`
    case "station.blocked":
      return `${name(event.stationId)} blocked: ${describeIssues(event.issues)}`
    case "station.reset":
      return `${name(event.stationId)} reset to run again`
    case "station.stop_requested":
      return `${name(event.stationId)} stop requested: ${event.reason}`
    case "station.run_retried":
      return `Engineer ${event.backoff ? "will retry" : "retrying"} ${name(event.stationId)}${event.backoff ? " after a pause" : ""}: ${describeIssues(event.issues)}`
    case "station.cancelled":
      return `${name(event.stationId)} cancelled: ${event.reason}`
    case "station.removal_requested":
      return `${name(event.stationId)} removal requested: ${event.reason}`
    case "station.removal_refused":
      return `${name(event.stationId)} removal refused: ${event.reason}`
    case "review.started":
      return `Conductor reviewing ${name(event.stationId)}`
    case "car.attached":
      return `Car attached to ${name(event.trainId)} from ${name(event.stationId)}`
    case "conflict.detected":
      return `Conflict detected in ${plural(event.paths.length, "file")}`
    case "conflict.resolved":
      return `Conflict resolved`
    case "hold.placed":
      return `Hold placed: ${event.hold.note || event.hold.kind}`
    case "hold.released":
      return `Hold released`
    case "terminus.integration_requested":
      return `${name(event.trainId)} requested entry into Terminus`
    case "terminus.integration_started":
      return `${name(event.trainId)} integrating into Terminus`
    case "terminus.integration_deferred":
      return `${name(event.trainId)} returned to the Terminus entry gate`
    case "terminus.integration_interrupted":
      return `${name(event.trainId)} integration needs recovery: ${describeIssues(event.issues)}`
    case "terminus.integration_retried":
      return `${name(event.trainId)} integration recovery requested`
    case "terminus.clearance_granted":
      return `Dispatcher cleared ${name(event.trainId)} into Terminus`
    case "terminus.candidate_prepared":
      return `${name(event.trainId)} prepared its merge into Terminus`
    case "terminus.promoted":
      return "Terminus updated with accepted work"
    case "terminus.integration_failed":
      return `${name(event.trainId)} integration stopped: ${describeIssues(event.issues)}`
    case "terminus.integration_completed":
      return `${name(event.trainId)} integrated into Terminus`
    case "terminus.published":
      return `Terminus ${event.commit.slice(0, 7)} published for deployment`
  }
}

function describeHold(reason: HoldReason, name: (id: string) => string) {
  return reason.kind === "awaiting_user_approval"
    ? "awaiting human approval in the review yard"
    : reason.kind === "dependency"
      ? `waiting on ${name(reason.stationId)}`
      : `${reason.kind.replace("_", " ")}`
}

export function describeIssues(issues: Issue[]): string {
  return issues.map((issue) => issue.detail).join("; ")
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
