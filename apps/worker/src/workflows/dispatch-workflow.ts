import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { dispatchPlanningPorts } from "../agents/ports"
import {
  dispatchPlanState,
  layDispatchLines,
  prepareDispatchPlan,
  recordDispatchFailure,
  startDispatchTrains,
} from "./dispatch-operations"

export interface DispatchWorkflowParams {
  planId: string
}
const retries = {
  limit: 2,
  delay: "2 seconds",
  backoff: "exponential",
} as const

/** One persisted proposal and launch. The UI submits intent; this Workflow owns execution. */
export class DispatchWorkflow extends WorkflowEntrypoint<
  Env,
  DispatchWorkflowParams
> {
  async run(event: WorkflowEvent<DispatchWorkflowParams>, step: WorkflowStep) {
    const ports = dispatchPlanningPorts(this.env)
    const { planId } = event.payload
    let phase: "planning" | "launching" = "planning"
    try {
      // Model output is saved before this step returns; retries reuse a saved proposal.
      await step.do(
        "prepare proposal",
        { retries, timeout: "10 minutes" },
        () => prepareDispatchPlan(ports, planId)
      )
      for (let gate = 0; ; gate++) {
        const status = await step.do(`launch gate ${gate}`, () =>
          dispatchPlanState(ports, planId)
        )
        if (status !== "ready") break
        try {
          await step.waitForEvent(`await launch ${gate}`, {
            type: "dispatcher.launch",
            timeout: "1 minute",
          })
        } catch {
          // The durable launch request is authoritative, so a lost wake cannot lose work.
        }
      }
      phase = "launching"
      await step.do(
        "lay planned lines",
        { retries, timeout: "15 minutes" },
        () => layDispatchLines(ports, planId)
      )
      await step.do(
        "start planned trains",
        { retries, timeout: "5 minutes" },
        () => startDispatchTrains(ports, planId)
      )
      return { planId, status: await dispatchPlanState(ports, planId) }
    } catch (error) {
      console.error("dispatcher.execution_failed", {
        planId,
        phase,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
      await step.do("record failure", { retries }, () =>
        recordDispatchFailure(ports, planId, phase)
      )
      // Starting Trains remain durable and inspectable if kickoff exhausts its retries.
      // Explicit retry restarts this same Workflow with stable repo/Train identities.
      throw new Error(`Dispatcher ${phase} failed; inspect plan ${planId}`, {
        // eslint-disable-next-line preserve-caught-error -- Raw model errors can contain private response context.
        cause: error instanceof Error ? error.name : "UnknownError",
      })
    }
  }
}
