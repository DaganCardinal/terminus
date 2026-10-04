import type { CommitId, TrainId } from "./ids"
import type { Train } from "./train"
import { isTerminal } from "./train"
import { accept, reject, type Transition } from "./transition"

export type UnloadMode = "auto" | "human_approval"

export interface UnloadRecommendation {
  mode: UnloadMode
  reason: string
}

/** Dispatcher-owned permission at the final gate; never a second Train state. */
export interface TrainUnloadPolicy {
  trainId: TrainId
  mode: UnloadMode
  recommendation?: UnloadRecommendation
  approval?: { trainCommit: CommitId; approvedAt: string }
}

/** Older Trains retain their automatic unloading behavior. */
export function hasUnloadPermission(
  train: Train,
  policy?: TrainUnloadPolicy | null
): boolean {
  return (
    !policy ||
    (policy.trainId === train.id &&
      (policy.mode === "auto" ||
        policy.approval?.trainCommit === train.headCommit))
  )
}

export function isAwaitingUnloadApproval(train: Train): boolean {
  return (
    train.state.status === "held" &&
    train.state.reasons.some(
      (reason) => reason.kind === "awaiting_user_approval"
    )
  )
}

export function changeUnloadMode(
  train: Train,
  policy: TrainUnloadPolicy,
  mode: UnloadMode
): Transition<TrainUnloadPolicy> {
  if (policy.trainId !== train.id)
    return reject("invalid_input", "Unload policy belongs to another Train")
  if (
    isTerminal(train) ||
    (train.state.status === "returning" && train.state.phase === "integrating")
  )
    return reject(
      "invalid_state",
      "Unload mode cannot change after integration starts"
    )
  if (policy.mode === mode) return accept(policy, [])
  // Returning to manual mode requires a fresh approval, even at the same commit.
  return accept(
    {
      trainId: policy.trainId,
      mode,
      ...(policy.recommendation
        ? { recommendation: policy.recommendation }
        : {}),
    },
    [{ type: "train.unload_mode_changed", trainId: train.id, mode }]
  )
}

export function approveTrainUnload(
  train: Train,
  policy: TrainUnloadPolicy,
  trainCommit: CommitId,
  approvedAt: string
): Transition<TrainUnloadPolicy> {
  if (policy.trainId !== train.id || policy.mode !== "human_approval")
    return reject("invalid_input", "Train is not configured for human approval")
  if (trainCommit !== train.headCommit)
    return reject(
      "invalid_input",
      "Train changed since review; reload before approving"
    )
  const atEntry =
    train.state.status === "returning"
      ? train.state.phase === "awaiting_clearance"
      : train.state.status === "held" &&
        train.state.resume.status === "returning"
  if (!atEntry)
    return reject(
      "invalid_state",
      "Train must finish its Stations before approval"
    )
  if (policy.approval?.trainCommit === trainCommit) return accept(policy, [])
  return accept({ ...policy, approval: { trainCommit, approvedAt } }, [
    {
      type: "train.unload_approved",
      trainId: train.id,
      trainCommit,
      approvedAt,
    },
  ])
}
