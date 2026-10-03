import type { ConflictId, TrainId } from "./ids"
import { accept, reject, type Transition } from "./transition"

/**
 * A real conflict found in actual changes. Forecast collisions are not
 * Conflicts: the Dispatcher handles those with sequencing holds.
 */
export interface Conflict {
  id: ConflictId
  trainIds: TrainId[]
  paths: string[]
  description: string
  status: "open" | "resolved"
}

export interface DetectConflictInput {
  id: ConflictId
  trainIds: TrainId[]
  paths: string[]
  description: string
}

export function detectConflict(
  input: DetectConflictInput
): Transition<Conflict> {
  if (input.trainIds.length === 0) {
    return reject("invalid_input", "A conflict must involve at least one Train")
  }
  return accept({ ...input, status: "open" }, [
    {
      type: "conflict.detected",
      conflictId: input.id,
      trainIds: input.trainIds,
      paths: input.paths,
    },
  ])
}

export function resolveConflict(conflict: Conflict): Transition<Conflict> {
  if (conflict.status !== "open") {
    return reject("invalid_state", `Conflict ${conflict.id} is not open`)
  }
  return accept({ ...conflict, status: "resolved" }, [
    { type: "conflict.resolved", conflictId: conflict.id },
  ])
}

export function openConflictsFor(
  trainId: TrainId,
  conflicts: Conflict[]
): Conflict[] {
  return conflicts.filter(
    (conflict) =>
      conflict.status === "open" && conflict.trainIds.includes(trainId)
  )
}
