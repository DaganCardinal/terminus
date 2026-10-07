import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import type { IntegrationOutcome } from "@terminus/protocol"
import { integrationPorts } from "../agents/ports"
import {
  failIntegration,
  prepareIntegration,
  promoteIntegration,
  reviewIntegration,
} from "./integration-operations"
import { TRAIN_EVENTS } from "./events"

export interface IntegrationWorkflowParams {
  integrationId: string
}
const retries = { limit: 5, delay: "1 second", backoff: "exponential" } as const

/** One attempt, with a durable Dispatcher reservation until its result is recorded. */
export class IntegrationWorkflow extends WorkflowEntrypoint<
  Env,
  IntegrationWorkflowParams
> {
  async run(
    event: WorkflowEvent<IntegrationWorkflowParams>,
    step: WorkflowStep
  ) {
    const ports = integrationPorts(this.env)
    const id = event.payload.integrationId
    let outcome: IntegrationOutcome
    let interrupted = false
    try {
      await step.do(
        "merge and validate",
        { retries, timeout: "30 minutes" },
        () => prepareIntegration(ports, id)
      )
      // Crossing and Junction-input candidates get a sandboxed Conductor
      // review, a paid session that verifies the app, so it gets one retry.
      await step.do(
        "Conductor review",
        { retries: { limit: 1, delay: "5 seconds" }, timeout: "30 minutes" },
        () => reviewIntegration(ports, id)
      )
      outcome = {
        integrationId: id,
        result: await step.do(
          "promote candidate",
          { retries, timeout: "10 minutes" },
          () => promoteIntegration(ports, id)
        ),
      }
    } catch (error) {
      try {
        outcome = {
          integrationId: id,
          result: await step.do(
            "reconcile failed attempt",
            { retries, timeout: "10 minutes" },
            () =>
              failIntegration(
                ports,
                id,
                error instanceof Error ? error.message : String(error)
              )
          ),
        }
      } catch (recoveryError) {
        interrupted = true
        outcome = {
          integrationId: id,
          result: await step.do("record interruption", { retries }, () =>
            ports.store.interruptIntegration(
              id,
              `Integration could not reconcile its canonical write; clearance remains reserved. ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
            )
          ),
        }
      }
    }
    await step.do("report to train", { retries }, async () => {
      const attempt = await ports.store.integration(id)
      if (!attempt) throw new Error("Unknown integration attempt")
      if (attempt.input.purpose === "junction") {
        const junction = await this.env.JUNCTION_WORKFLOW.get(
          attempt.input.junctionId!
        )
        await junction.sendEvent({ type: "junction-wake", payload: {} })
        return
      }
      const train = await this.env.TRAIN_WORKFLOW.get(attempt.input.trainId)
      await train.sendEvent({
        type: TRAIN_EVENTS.integrationOutcome,
        payload: outcome,
      })
    })
    if (interrupted)
      throw new Error(
        "Integration needs explicit recovery; clearance remains reserved"
      )
    await step.do("wake returning trains", { retries }, async () => {
      const attempt = await ports.store.integration(id)
      for (const { value } of await ports.store.trains(
        attempt!.input.networkId
      )) {
        if (
          value.state.status !== "returning" ||
          value.id === attempt!.input.trainId
        )
          continue
        try {
          const train = await this.env.TRAIN_WORKFLOW.get(value.id)
          await train.sendEvent({ type: TRAIN_EVENTS.wake, payload: {} })
        } catch {
          /* The Train also periodically rechecks its durable gate. */
        }
      }
    })
    return outcome
  }
}
