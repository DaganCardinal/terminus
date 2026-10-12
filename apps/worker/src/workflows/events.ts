/** Workflow transport event types cannot contain dots, unlike domain events. */
export const DISPATCH_EVENTS = {
  launch: "dispatcher-launch",
} as const

/** Workflow event types the Train Workflow waits for. */
export const TRAIN_EVENTS = {
  /** A Station run finished. Payload: StationOutcome. */
  stationOutcome: "station-outcome",
  /** Something a held Train may be waiting on changed. */
  wake: "train-wake",
  /** Intervention resolved a blocked Train's issue. */
  clear: "train-clear",
  /** A persisted Terminus integration result is ready for the Train to consume. */
  integrationOutcome: "integration-outcome",
} as const

export interface TrainWorkflowParams {
  trainId: string
}
