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
import { trainPorts } from "../agents/ports"
import { TRAIN_EVENTS, type TrainWorkflowParams } from "./events"
import {
  advanceTrain,
  clearTrain,
  recordStationOutcome,
  recordIntegrationOutcome,
} from "./train-operations"

const stepConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
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
    const ports = trainPorts(this.env)
    const { trainId } = event.payload

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
