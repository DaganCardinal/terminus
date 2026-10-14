import type { Hold, HoldReason } from "./hold"
import type {
  CarId,
  HoldId,
  CommitId,
  ConflictId,
  LineId,
  RepoId,
  StationId,
  TrainId,
} from "./ids"
import type { Issue } from "./issue"
import type { ReviewFeedback } from "./station"

/**
 * Every domain change, as recorded in the network's event log. The activity
 * feed and the audit trail are both built from these.
 */
export type DomainEvent =
  | {
      type: "engineer.assessed"
      trainId: TrainId
      assessmentId: string
      purpose: string
      action: string
    }
  | {
      type: "dispatcher.engineer_notice_raised"
      trainId: TrainId
      noticeId: string
      summary: string
    }
  | {
      type: "dispatcher.engineer_notice_acknowledged"
      trainId: TrainId
      noticeId: string
    }
  | {
      type: "dispatcher.engineer_notice_resolved"
      trainId: TrainId
      noticeId: string
    }
  | {
      type: "dispatcher.conflict_investigating"
      trainId: TrainId
      watchId: string
      otherTrainId: TrainId
      route: "overlap" | "triage"
    }
  | {
      type: "dispatcher.conflict_reported"
      trainId: TrainId
      watchId: string
      otherTrainId: TrainId
      summary: string
      paths: string[]
    }
  | {
      type: "dispatcher.conflict_cleared"
      trainId: TrainId
      watchId: string
      otherTrainId: TrainId
      summary: string
    }
  | {
      type: "dispatcher.conflict_investigation_failed"
      trainId: TrainId
      watchId: string
      otherTrainId: TrainId
      reason: string
    }
  | {
      type: "dispatcher.conflict_acknowledged"
      trainId: TrainId
      watchId: string
      otherTrainId: TrainId
    }
  | {
      type: "station.run_failed"
      trainId: TrainId
      stationId: StationId
      runId: string
      issues: Issue[]
      phase?: string
    }
  | {
      type:
        | "junction.created"
        | "junction.review_started"
        | "junction.ready"
        | "junction.retried"
        | "junction.abandoned"
      junctionId: string
    }
  | {
      type: "junction.candidate_prepared" | "junction.promotion_confirmed"
      junctionId: string
      trainId: string
      integrationId: string
      mergeCommit: string
    }
  | {
      type: "junction.integration_failed" | "junction.integration_interrupted"
      junctionId: string
      trainId: string
      integrationId: string
      issues: Issue[]
    }
  | {
      type: "junction.integration_retried" | "junction.integration_reviewed"
      junctionId: string
      trainId: string
      integrationId: string
    }
  | {
      type: "junction.release_approved"
      junctionId: string
      mergeCommit: string
    }
  | {
      type: "junction.input_accepted"
      junctionId: string
      trainId: string
      integrationId: string
      mergeCommit: string
    }
  | {
      type: "junction.released" | "junction.train_unloaded"
      junctionId: string
      trainId: string
      mergeCommit: string
    }
  | {
      type: "junction.blocked" | "dispatcher.junction_attention_requested"
      junctionId: string
      issues: Issue[]
    }
  | {
      type: "junction.integration_requested" | "junction.integration_started"
      junctionId: string
      trainId: string
    }
  | {
      type: "crossing.created"
      crossingId: string
      trainId: string
      stationId: string
    }
  | {
      type: "crossing.approaching"
      crossingId: string
      trainId: string
      stationId: string
    }
  | {
      type: "crossing.started"
      crossingId: string
      trainId: string
      stationId: string
    }
  | {
      type: "crossing.blocked"
      crossingId: string
      trainId: string
      stationId: string
    }
  | {
      type: "crossing.retried"
      crossingId: string
      trainId: string
      stationId: string
    }
  | {
      type: "crossing.completed"
      crossingId: string
      trainId: string
      stationId: string
      mergeCommit: string
      carIds: string[]
    }
  | {
      type: "train.unload_mode_changed"
      trainId: TrainId
      mode: import("./unload-policy").UnloadMode
    }
  | {
      type: "train.unload_approved"
      trainId: TrainId
      trainCommit: CommitId
      approvedAt: string
    }
  | {
      type: "dispatcher.unload_mode_changed"
      planId: string
      lineKey: string
      mode: import("./unload-policy").UnloadMode
    }
  | {
      type: "technician.integration_failed"
      repairId: string
      trainId: TrainId
    }
  | { type: "technician.validated"; repairId: string; trainId: TrainId }
  | { type: "technician.dispatched"; repairId: string; trainId: TrainId }
  | { type: "technician.started"; repairId: string; trainId: TrainId }
  | {
      type: "technician.candidate_prepared"
      repairId: string
      trainId: TrainId
    }
  | { type: "technician.reviewed"; repairId: string; trainId: TrainId }
  | { type: "technician.approved"; repairId: string; trainId: TrainId }
  | { type: "technician.failed"; repairId: string; trainId: TrainId }
  | { type: "technician.integrated"; repairId: string; trainId: TrainId }
  | { type: "technician.stale"; repairId: string; trainId: TrainId }
  | {
      type: "dispatcher.user_attention_requested"
      trainId: TrainId
      stationId: StationId
      issues: Issue[]
    }
  | { type: "dispatcher.plan_requested"; planId: string }
  | { type: "dispatcher.plan_ready"; planId: string }
  | { type: "dispatcher.launch_requested"; planId: string }
  | { type: "dispatcher.plan_failed"; planId: string }
  | { type: "dispatcher.plan_cancelled"; planId: string }
  | { type: "dispatcher.plan_stopped"; planId: string }
  | {
      type: "dispatcher.baseline_fix_selected"
      planId: string
      selection: import("./dispatch-plan").BaselineFixSelection
    }
  | {
      type: "dispatcher.lines_laid"
      planId: string
      lineIds: LineId[]
      trainIds: TrainId[]
    }
  | {
      type: "dispatcher.plan_launched"
      planId: string
      lineIds: LineId[]
      trainIds: TrainId[]
    }
  | { type: "line.created"; lineId: LineId; stationIds: StationId[] }
  | {
      type: "train.created"
      trainId: TrainId
      lineId: LineId
      repoId: RepoId
      terminusBaseline: CommitId
    }
  | { type: "train.departed"; trainId: TrainId; stationId: StationId }
  | { type: "train.approaching"; trainId: TrainId; stationId: StationId }
  | { type: "train.arrived"; trainId: TrainId; stationId: StationId }
  | { type: "train.held"; trainId: TrainId; reasons: HoldReason[] }
  | { type: "train.released"; trainId: TrainId }
  | { type: "train.blocked"; trainId: TrainId; issues: Issue[] }
  | { type: "train.issue_raised"; trainId: TrainId; issues: Issue[] }
  | { type: "train.cleared"; trainId: TrainId }
  | { type: "train.returning"; trainId: TrainId }
  | { type: "train.unloaded"; trainId: TrainId }
  | { type: "train.sided"; trainId: TrainId; reason: string }
  | { type: "station.signaled"; stationId: StationId; trainId: TrainId }
  | {
      type: "station.workspace_created"
      stationId: StationId
      repoId: RepoId
      baseCommit: CommitId
    }
  | { type: "station.started"; stationId: StationId }
  | {
      type: "station.ready_for_pickup"
      stationId: StationId
      headCommit: CommitId
    }
  | {
      type: "station.returned"
      stationId: StationId
      trainId: TrainId
      feedback: ReviewFeedback
    }
  | { type: "station.blocked"; stationId: StationId; issues: Issue[] }
  | { type: "station.reset"; stationId: StationId }
  | { type: "station.stop_requested"; stationId: StationId; reason: string }
  | {
      type: "station.run_retried"
      stationId: StationId
      trainId: TrainId
      issues: Issue[]
      /** Whether the Engineer waits before starting the run again. */
      backoff: boolean
    }
  | { type: "station.cancelled"; stationId: StationId; reason: string }
  | { type: "station.removal_requested"; stationId: StationId; reason: string }
  | { type: "station.removal_refused"; stationId: StationId; reason: string }
  | { type: "review.started"; trainId: TrainId; stationId: StationId }
  | {
      type: "car.attached"
      carId: CarId
      trainId: TrainId
      stationId: StationId
      acceptedCommit: CommitId
    }
  | {
      type: "conflict.detected"
      conflictId: ConflictId
      trainIds: TrainId[]
      paths: string[]
    }
  | { type: "conflict.resolved"; conflictId: ConflictId }
  | { type: "hold.placed"; hold: Hold }
  | { type: "hold.released"; holdId: HoldId }
  | { type: "terminus.integration_requested"; trainId: TrainId }
  | { type: "terminus.integration_started"; trainId: TrainId }
  | { type: "terminus.integration_deferred"; trainId: TrainId }
  | {
      type: "terminus.integration_interrupted"
      trainId: TrainId
      integrationId: string
      issues: Issue[]
    }
  | {
      type: "terminus.integration_retried"
      trainId: TrainId
      integrationId: string
    }
  | {
      type: "terminus.clearance_granted"
      trainId: TrainId
      integrationId: string
    }
  | {
      type: "terminus.candidate_prepared"
      trainId: TrainId
      integrationId: string
      mergeCommit: CommitId
    }
  | {
      type: "terminus.promoted"
      trainId: TrainId
      integrationId: string
      mergeCommit: CommitId
    }
  | {
      type: "terminus.integration_failed"
      trainId: TrainId
      integrationId: string
      issues: Issue[]
    }
  | {
      type: "terminus.integration_completed"
      trainId: TrainId
      mergeCommit: CommitId
    }
  | {
      type: "terminus.published"
      commit: CommitId
    }

export type DomainEventType = DomainEvent["type"]
