import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { junctionExecutionPorts } from "../agents/ports"
import { advanceJunction, failJunction } from "./junction-operations"

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
    const ports = junctionExecutionPorts(this.env, model)
    for (let n = 0; ; n++) {
      let move: "moved" | "wait" | "finished"
      try {
        move = await step.do(
          `advance Junction ${n}`,
          {
            retries: { limit: 5, delay: "1 second", backoff: "exponential" },
            timeout: "30 minutes",
          },
          () => advanceJunction(ports, id)
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
