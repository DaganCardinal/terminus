import type { NetworkSnapshot } from "@terminus/protocol"

/** How the floating Dispatcher presents itself. Derived from the snapshot on
 * every render; it is a view of network state, never stored. */
export type DispatcherTone = "idle" | "working" | "review" | "attention"

export interface DispatcherIndicator {
  tone: DispatcherTone
  label: string
}

export function dispatcherIndicator(
  snapshot: NetworkSnapshot
): DispatcherIndicator {
  const latest = snapshot.plans.at(-1)
  const blocked = snapshot.trains.filter(
    ({ train }) => train.state.status === "blocked"
  ).length
  const conflicts = snapshot.conflicts.filter((c) => c.status === "open").length

  if (blocked > 0)
    return {
      tone: "attention",
      label:
        blocked === 1 ? "A Train needs attention" : `${blocked} Trains blocked`,
    }
  if (conflicts > 0)
    return {
      tone: "attention",
      label: conflicts === 1 ? "Open conflict" : `${conflicts} open conflicts`,
    }
  const awaitingReview = snapshot.trains.filter(
    ({ train }) =>
      train.state.status === "held" &&
      train.state.reasons.some((r) => r.kind === "awaiting_user_approval")
  ).length
  if (awaitingReview)
    return {
      tone: "review",
      label: `${awaitingReview} ${awaitingReview === 1 ? "Train awaits" : "Trains await"} approval`,
    }
  const reported = (snapshot.conflictConcerns ?? []).filter(
    (concern) => concern.pair.stage === "confirmed"
  ).length
  if (reported)
    return {
      tone: "attention",
      label:
        reported === 1
          ? "Possible conflict between Lines"
          : `${reported} possible conflicts`,
    }
  if (snapshot.engineerNotices?.length)
    return {
      tone: "attention",
      label:
        snapshot.engineerNotices.length === 1
          ? "An Engineer flagged a concern"
          : `${snapshot.engineerNotices.length} Engineer concerns`,
    }
  if (latest?.state.status === "failed" && latest.state.reason === "cancelled")
    return latest.state.cleanupPending
      ? { tone: "working", label: "Stopping planning" }
      : { tone: "idle", label: "Planning stopped" }
  if (latest?.state.status === "failed")
    return { tone: "attention", label: "Plan stopped" }
  if (latest?.state.status === "ready")
    return { tone: "review", label: "Plan ready to review" }
  if (latest?.state.status === "planning")
    return { tone: "working", label: "Preparing a plan" }
  if (
    latest?.state.status === "launching" ||
    latest?.state.status === "starting"
  )
    return { tone: "working", label: "Launching Lines" }
  if (
    snapshot.conflictConcerns?.some(
      (concern) => concern.pair.stage === "investigate"
    )
  )
    return { tone: "working", label: "Checking for conflicts" }
  return { tone: "idle", label: "Dispatcher" }
}
