import type { HoldId, LineId, StationId, TrainId } from "./ids"
import { accept, reject, type Transition } from "./transition"

/** `user` holds are placed by the user; `sequencing` holds by the Dispatcher. */
export type HoldKind = "user" | "sequencing"

export type HoldScope =
  | { kind: "network" }
  | { kind: "line"; lineId: LineId }
  | { kind: "train"; trainId: TrainId }

/** A deliberate, expected stop. Held Trains resume once their holds clear. */
export interface Hold {
  id: HoldId
  kind: HoldKind
  scope: HoldScope
  note: string
}

export type HoldReason =
  | { kind: "awaiting_user_approval"; trainCommit: string }
  | { kind: "user_hold"; holdId: HoldId }
  | { kind: "sequencing"; holdId: HoldId }
  | { kind: "dependency"; stationId: StationId }

export function holdsApplyingTo(
  train: { id: TrainId; lineId: LineId },
  holds: Hold[]
): Hold[] {
  return holds.filter((hold) => {
    switch (hold.scope.kind) {
      case "network":
        return true
      case "line":
        return hold.scope.lineId === train.lineId
      case "train":
        return hold.scope.trainId === train.id
    }
  })
}

export function holdReason(hold: Hold): HoldReason {
  return hold.kind === "user"
    ? { kind: "user_hold", holdId: hold.id }
    : { kind: "sequencing", holdId: hold.id }
}

export function placeHold(hold: Hold): Transition<Hold> {
  return accept(hold, [{ type: "hold.placed", hold }])
}

/** Releases a hold. The caller removes it; the event keeps it in history. */
export function releaseHold(hold: Hold, active: Hold[]): Transition<Hold> {
  if (!active.some((existing) => existing.id === hold.id)) {
    return reject("invalid_state", `Hold ${hold.id} is not active`)
  }
  return accept(hold, [{ type: "hold.released", holdId: hold.id }])
}
