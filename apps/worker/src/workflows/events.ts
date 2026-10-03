/** Workflow event types the Train Workflow waits for. */
export const TRAIN_EVENTS = {
  /** A Station run finished. Payload: StationOutcome. */
  stationOutcome: "station-outcome",
  /** Something a held Train may be waiting on changed. */
  wake: "train-wake",
  /** Intervention resolved a blocked Train's issue. */
  clear: "train-clear",
  /** The Dispatcher cleared the Train into Terminus. */
  terminusClearance: "terminus-clearance",
} as const

export interface TrainWorkflowParams {
  trainId: string
}
