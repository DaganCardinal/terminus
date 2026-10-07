import {
  stationOutcomeSchema,
  integrationOutcomeSchema,
  trainClearEventSchema,
  type IntegrationOutcome,
  type StationOutcome,
} from "@terminus/protocol"
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import { trainModels, trainPorts } from "../agents/ports"
import { TRAIN_EVENTS, type TrainWorkflowParams } from "./events"
import {
  advanceTrain,
  clearTrain,
  failReview,
  recordStationOutcome,
  recordIntegrationOutcome,
  reviewStation,
} from "./train-operations"

const stepConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
}

/** A harness review is a paid session that verifies the app, so it gets one retry. */
const reviewConfig: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds" },
  timeout: "30 minutes",
}

/**
 * Runs one Train from its depot to `unloaded` or `siding`. It is the only
 * writer of the Train's state; everyone else sends it events.
 */
export class TrainWorkflow extends WorkflowEntrypoint<
  Env,
  TrainWorkflowParams
> {
  async run(event: WorkflowEvent<TrainWorkflowParams>, step: WorkflowStep) {
    const { trainId } = event.payload
    // A Train keeps the models its network chose when it started running.
    const models = await step.do("resolve role models", stepConfig, () =>
      trainModels(this.env, trainId)
    )
    const ports = trainPorts(this.env, models)

    for (let leg = 1; ; leg++) {
      const move = await step.do(`advance ${leg}`, stepConfig, () =>
        advanceTrain(ports, trainId)
      )
      switch (move.kind) {
        case "moved":
          break
        case "await_station": {
          const payload = await waitFor<StationOutcome>(
            step,
            `await ${move.runId} (${leg})`,
            TRAIN_EVENTS.stationOutcome,
            "1 day"
          )
          if (payload !== null) {
            const outcome = stationOutcomeSchema.parse(payload)
            await step.do(`record ${move.runId} (${leg})`, stepConfig, () =>
              recordStationOutcome(ports, trainId, outcome)
            )
          }
          break
        }
        case "review":
          try {
            await step.do(
              `review ${move.stationId} (${leg})`,
              reviewConfig,
              () => reviewStation(ports, trainId)
            )
          } catch {
            await step.do(
              `review failed ${move.stationId} (${leg})`,
              stepConfig,
              () => failReview(ports, trainId)
            )
          }
          break
        case "await_wake":
          // Wakes are a shortcut; the gate is re-checked periodically anyway.
          await waitFor(step, `held (${leg})`, TRAIN_EVENTS.wake, "10 minutes")
          break
        case "await_clear": {
          const payload = await waitFor(
            step,
            `blocked (${leg})`,
            TRAIN_EVENTS.clear,
            "1 minute"
          )
          if (
            payload !== null &&
            !trainClearEventSchema.parse(payload).reevaluateOnly
          ) {
            await step.do(`clear (${leg})`, stepConfig, () =>
              clearTrain(ports, trainId)
            )
          }
          break
        }
        case "await_terminus":
          await waitFor(
            step,
            `clearance (${leg})`,
            TRAIN_EVENTS.wake,
            "1 minute"
          )
          break
        case "await_integration": {
          const payload = await waitFor<IntegrationOutcome>(
            step,
            `integrate ${move.integrationId} (${leg})`,
            TRAIN_EVENTS.integrationOutcome,
            "10 minutes"
          )
          if (payload !== null) {
            const outcome = integrationOutcomeSchema.parse(payload)
            await step.do(
              `record integration ${move.integrationId} (${leg})`,
              stepConfig,
              () => recordIntegrationOutcome(ports, trainId, outcome)
            )
          }
          break
        }
        case "finished":
          return move
      }
    }
  }
}

/** Waits for an event, returning its payload, or null on timeout. */
async function waitFor<T extends Rpc.Serializable<T> = object>(
  step: WorkflowStep,
  name: string,
  type: string,
  timeout: `${number} ${"minute" | "minutes" | "day"}`
): Promise<Readonly<T> | null> {
  try {
    const event = await step.waitForEvent<T>(name, { type, timeout })
    return event.payload
  } catch {
    return null
  }
}
