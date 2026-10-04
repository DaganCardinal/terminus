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
  return { tone: "idle", label: "Dispatcher" }
}
