import type { StationRunResult } from "@terminus/agent-runtime"
import { timedStep, type StationOutcome } from "@terminus/protocol"
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import { stationPorts, trainModels } from "../agents/ports"
import { TRAIN_EVENTS } from "./events"
import { prepareStation, runStationAgent } from "./station-operations"
import type { StationRunParams } from "./train-operations"

const stepConfig: WorkflowStepConfig = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
}

/**
 * One run of a Station: prepares its workspace, runs the Station Agent, and
 * reports the outcome to the Train. It never writes the Train's state.
 */
export class StationWorkflow extends WorkflowEntrypoint<Env, StationRunParams> {
  async run(event: WorkflowEvent<StationRunParams>, step: WorkflowStep) {
    const params = event.payload
    const models = await step.do(
      "resolve role models",
      stepConfig,
      timedStep("station", params.runId, "resolve role models", () =>
        trainModels(this.env, params.trainId)
      )
    )
    const ports = stationPorts(this.env, models)

    let result: StationRunResult
    try {
      await step.do(
        "prepare workspace",
        stepConfig,
        timedStep("station", params.runId, "prepare workspace", () =>
          prepareStation(ports, params)
        )
      )
      result = await step.do(
        "run station agent",
        {
          retries: { limit: 1, delay: "5 seconds" },
          timeout: "30 minutes",
        },
        timedStep(
          "station",
          params.runId,
          "run station agent",
          () => runStationAgent(ports, params),
          (result) => ({ ok: result.ok })
        )
      )
    } catch (error) {
      result = {
        ok: false,
        issues: [
          {
            kind: "station_failed",
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }

    const outcome: StationOutcome = {
      stationId: params.stationId,
      runId: params.runId,
      result,
    }
    await step.do(
      "report to train",
      stepConfig,
      timedStep("station", params.runId, "report to train", () =>
        this.env.TRAIN_WORKFLOW.get(params.trainId).then((train) =>
          train.sendEvent({
            type: TRAIN_EVENTS.stationOutcome,
            payload: outcome,
          })
        )
      )
    )
    return outcome
  }
}
