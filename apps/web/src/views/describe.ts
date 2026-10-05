import type {
  DomainEvent,
  HoldReason,
  Issue,
  NetworkSnapshot,
  TrainState,
} from "@terminus/protocol"

/** Display names for the ids in a snapshot. */
export function namesFor(snapshot: NetworkSnapshot): (id: string) => string {
  const names = new Map<string, string>()
  for (const line of snapshot.lines) names.set(line.id, line.name)
  for (const station of snapshot.stations) names.set(station.id, station.name)
  for (const { train } of snapshot.trains) {
    names.set(train.id, `${names.get(train.lineId) ?? "Unknown"} Train`)
  }
  return (id) => names.get(id) ?? id
}

export function describeLocation(
  state: TrainState,
  name: (id: string) => string
): string {
  switch (state.status) {
    case "ready":
      return state.at.kind === "depot"
        ? "At the depot"
        : `At ${name(state.at.stationId)}`
    case "in_transit":
      return `Working toward ${name(state.toward)}`
    case "approaching":
      return `Approaching ${name(state.toward)}`
    case "docked":
      return `Docked at ${name(state.at)}`
    case "reviewing":
      return `Reviewing work at ${name(state.at)}`
    case "held":
      return `Held: ${state.reasons.map((reason) => describeHold(reason, name)).join("; ")}`
    case "blocked":
      return `Blocked: ${describeIssues(state.issues)}`
    case "returning":
      return state.phase === "integrating"
        ? "Integrating into Terminus"
        : "Waiting for clearance into Terminus"
    case "unloaded":
      return "Unloaded into Terminus"
    case "siding":
      return `On the siding: ${state.reason}`
  }
}

export function describeEvent(
  event: DomainEvent,
  name: (id: string) => string
): string {
  switch (event.type) {
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
    case "dispatcher.plan_failed":
      return "Dispatcher plan stopped; inspect its details"
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
      return `${name(event.trainId)} returning to Terminus`
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
