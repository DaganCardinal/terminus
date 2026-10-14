import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { conflictWatchPorts, trainModels } from "../agents/ports"
import {
  abandonConflictInvestigation,
  investigateConflict,
  pendingConflictPairs,
  triageConflict,
} from "./conflict-watch-operations"

export interface ConflictWatchWorkflowParams {
  watchId: string
  trainId: string
}

const retries = {
  limit: 5,
  delay: "1 second",
  backoff: "exponential",
} as const

/**
 * The Dispatcher's check of one new Car against other running Trains: Clef
 * triage for pairs that share no files, then a Sandbox investigation for
 * every pair that needs one. Reports are advisory and never move a Train.
 */
export class ConflictWatchWorkflow extends WorkflowEntrypoint<
  Env,
  ConflictWatchWorkflowParams
> {
  async run(
    event: WorkflowEvent<ConflictWatchWorkflowParams>,
    step: WorkflowStep
  ) {
    const { watchId, trainId } = event.payload
    // The watch uses the models the Train started with.
    const models = await step.do("resolve role models", { retries }, () =>
      trainModels(this.env, trainId)
    )
    const ports = conflictWatchPorts(this.env, models)
    const initial = await step.do("pending pairs", { retries }, () =>
      pendingConflictPairs(ports, watchId)
    )
    for (const otherTrainId of initial.triage)
      await step.do(`triage ${otherTrainId}`, { retries }, () =>
        triageConflict(ports, watchId, otherTrainId)
      )
    const { investigate } = await step.do(
      "pairs to investigate",
      { retries },
      () => pendingConflictPairs(ports, watchId)
    )
    for (const otherTrainId of investigate) {
      try {
        await step.do(
          `investigate ${otherTrainId}`,
          // Each attempt is a Sandbox session; capacity limits clear with time.
          {
            retries: { limit: 2, delay: "2 minutes", backoff: "exponential" },
            timeout: "30 minutes",
          },
          () => investigateConflict(ports, watchId, otherTrainId)
        )
      } catch (error) {
        await step.do(`investigation failed ${otherTrainId}`, { retries }, () =>
          abandonConflictInvestigation(
            ports,
            watchId,
            otherTrainId,
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    }
  }
}
