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
  | { type: "station.cancelled"; stationId: StationId; reason: string }
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
  | {
      type: "terminus.integration_completed"
      trainId: TrainId
      mergeCommit: CommitId
    }

export type DomainEventType = DomainEvent["type"]
