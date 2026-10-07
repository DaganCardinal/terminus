import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { junctionExecutionPorts } from "../agents/ports"
import {
  advanceJunction,
  failJunction,
  reviewJunctionFeature,
  type JunctionMove,
} from "./junction-operations"

export class JunctionWorkflow extends WorkflowEntrypoint<
  Env,
  { junctionId: string }
> {
  async run(event: WorkflowEvent<{ junctionId: string }>, step: WorkflowStep) {
    const id = event.payload.junctionId
    const model = await step.do("resolve Junction Conductor", async () => {
      const j = await junctionExecutionPorts(this.env, "fake").store.junction(
        id
      )
      if (!j) throw new Error("Unknown Junction")
      return j.value.conductorModel
    })
    const execution = await step.do(
      "resolve Junction harness",
      async () =>
        (
          await junctionExecutionPorts(this.env, "fake").store.executionConfig(
            "junction",
            id
          )
        )?.conductor ?? null
    )
    const ports = junctionExecutionPorts(
      this.env,
      model,
      execution ?? undefined
    )
    for (let n = 0; ; n++) {
      let move: JunctionMove
      try {
        move = await step.do(
          `advance Junction ${n}`,
          {
            retries: { limit: 5, delay: "1 second", backoff: "exponential" },
            timeout: "30 minutes",
          },
          () => advanceJunction(ports, id)
        )
        // Feature validation plus a sandboxed review, a paid session that
        // verifies the app, so it gets one retry.
        if (move === "review")
          move = await step.do(
            `review Junction feature ${n}`,
            {
              retries: { limit: 1, delay: "5 seconds" },
              timeout: "45 minutes",
            },
            async () => {
              await reviewJunctionFeature(ports, id)
              return "moved" as const
            }
          )
      } catch (error) {
        await step.do(`record Junction failure ${n}`, () =>
          failJunction(
            ports,
            id,
            error instanceof Error ? error.message : String(error)
          )
        )
        move = "wait"
      }
      if (move === "finished") return
      if (move === "wait") {
        try {
          await step.waitForEvent(`wait Junction ${n}`, {
            type: "junction-wake",
            timeout: "1 minute",
          })
        } catch {
          /* Durable state is rechecked on timeout. */
        }
      }
    }
  }
}
