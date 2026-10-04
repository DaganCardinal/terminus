import { openConflictsFor, type Conflict } from "./conflict"
import { failingRequiredChecks, type CheckResult } from "./evidence"
import { holdReason, holdsApplyingTo, type Hold, type HoldReason } from "./hold"
import type { StationId } from "./ids"
import type { Issue } from "./issue"
import type { Station, StationStatus } from "./station"
import type { Train } from "./train"
import { hasConcreteRepositoryChange } from "./manifest"

/**
 * The Engineer's decision at a gate. `hold` is an expected stop that clears on
 * its own; `block` needs intervention. The hard rules decide this, and no
 * model can override them.
 */
export type GateDecision =
  | { kind: "clear" }
  | { kind: "hold"; reasons: HoldReason[] }
  | { kind: "block"; issues: Issue[] }

export const DEFAULT_STATION_MAX_RETRIES = 3

/** Initial work is followed by at most this many automatic revisions. */
export function evaluateStationRetry(
  station: Station,
  maxRetries = DEFAULT_STATION_MAX_RETRIES
): GateDecision {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
    throw new RangeError("Station max retries must be a nonnegative integer")
  // Older persisted Stations have only the lifetime revision counter.
  if ((station.retryCount ?? station.revisionCount) < maxRetries)
    return { kind: "clear" }
  return {
    kind: "block",
    issues: [
      {
        kind: "station_retries_exhausted",
        detail: `Station ${station.name} exhausted its allowance of ${maxRetries} automatic retries. User intervention is required.`,
      },
    ],
  }
}

export interface GateContext {
  /** Every active hold in the network. Only those applying to the Train count. */
  holds: Hold[]
  /** Every known conflict. Only open ones involving the Train count. */
  conflicts: Conflict[]
  /** The latest validation of the Train's own state. */
  trainChecks: CheckResult[]
}

export interface DepartureContext extends GateContext {
  /** The current status of each Station the next Station depends on. */
  dependencies: Partial<Record<StationId, StationStatus>>
}

/** Whether the Train may depart toward `station`, its next Station. */
export function evaluateDeparture(
  train: Train,
  station: Station,
  context: DepartureContext
): GateDecision {
  const issues = blockingIssues(train, context)
  const reasons = holdReasons(train, context)

  if (!hasConcreteRepositoryChange(station.manifest))
    issues.push({
      kind: "station_change_required",
      detail: `Station ${station.id} has no declared concrete repository change. Revise the plan or remove the Station.`,
    })

  for (const dependency of station.manifest.dependencies) {
    const status = context.dependencies[dependency]
    if (status === "complete") continue
    if (status === undefined || status === "cancelled") {
      issues.push({
        kind: "dependency_unresolvable",
        detail: `Station ${station.id} depends on ${dependency}, which is ${status ?? "unknown"}`,
      })
    } else {
      reasons.push({ kind: "dependency", stationId: dependency })
    }
  }

  return decide(issues, reasons)
}

/** Whether a returning Train may begin integrating into Terminus. */
export function evaluateTerminusEntry(
  train: Train,
  context: GateContext
): GateDecision {
  return decide(blockingIssues(train, context), holdReasons(train, context))
}

/**
 * Blocking conditions that apply at every gate: failed required checks and
 * unresolved conflicts.
 */
export function blockingIssues(
  train: Train,
  context: Pick<GateContext, "conflicts" | "trainChecks">
): Issue[] {
  const issues: Issue[] = []
  const failing = failingRequiredChecks(context.trainChecks)
  if (failing.length > 0) {
    issues.push({
      kind: "required_checks_failed",
      detail: `Required checks did not pass: ${failing.map((check) => check.name).join(", ")}`,
    })
  }
  for (const conflict of openConflictsFor(train.id, context.conflicts)) {
    issues.push({
      kind: "conflict",
      detail: `Conflict ${conflict.id} is unresolved: ${conflict.description}`,
    })
  }
  return issues
}

export type SignalAspect = "green" | "red"

/**
 * The map's signal for a Train: red when it is held or blocked. Derived from
 * the Train's state and never stored. Terminal Trains have no signal.
 */
export function signalFor(train: Train): SignalAspect | null {
  switch (train.state.status) {
    case "held":
    case "blocked":
      return "red"
    case "unloaded":
    case "siding":
      return null
    default:
      return "green"
  }
}

function holdReasons(train: Train, context: GateContext): HoldReason[] {
  return holdsApplyingTo(train, context.holds).map(holdReason)
}

function decide(issues: Issue[], reasons: HoldReason[]): GateDecision {
  if (issues.length > 0) return { kind: "block", issues }
  if (reasons.length > 0) return { kind: "hold", reasons }
  return { kind: "clear" }
}
