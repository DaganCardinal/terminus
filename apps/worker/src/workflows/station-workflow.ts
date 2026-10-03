import type { StationRunResult } from "@terminus/agent-runtime"
import type { StationOutcome } from "@terminus/protocol"
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import { stationPorts } from "../agents/ports"
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
    const ports = stationPorts(this.env)
    const params = event.payload

    let result: StationRunResult
    try {
      await step.do("prepare workspace", stepConfig, () =>
        prepareStation(ports, params)
      )
      result = await step.do(
        "run station agent",
        {
          retries: { limit: 1, delay: "5 seconds" },
          timeout: "30 minutes",
        },
        () => runStationAgent(ports, params)
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
    await step.do("report to train", stepConfig, () =>
      this.env.TRAIN_WORKFLOW.get(params.trainId).then((train) =>
        train.sendEvent({ type: TRAIN_EVENTS.stationOutcome, payload: outcome })
      )
    )
    return outcome
  }
}
