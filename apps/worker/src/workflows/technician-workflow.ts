import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { repairModels, technicianPorts } from "../agents/ports"
import {
  prepareTechnician,
  runTechnician,
  validateTechnician,
  reviewTechnician,
  failTechnician,
} from "./technician-operations"

export class TechnicianWorkflow extends WorkflowEntrypoint<
  Env,
  { repairId: string }
> {
  async run(event: WorkflowEvent<{ repairId: string }>, step: WorkflowStep) {
    const id = event.payload.repairId
    const retries = {
      limit: 5,
      delay: "1 second",
      backoff: "exponential",
    } as const
    const models = await step.do("resolve role models", { retries }, () =>
      repairModels(this.env, id)
    )
    const ports = technicianPorts(this.env, models)
    try {
      await step.do(
        "prepare repair workspace",
        { retries, timeout: "10 minutes" },
        () => prepareTechnician(ports, id)
      )
      await step.do(
        "resolve and persist candidate",
        { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" },
        () => runTechnician(ports, id)
      )
      await step.do(
        "independent project validation",
        { retries, timeout: "30 minutes" },
        () => validateTechnician(ports, id)
      )
      await step.do(
        "Conductor reconciliation review",
        // A sandboxed review is a paid session that verifies the app.
        { retries: { limit: 1, delay: "5 seconds" }, timeout: "30 minutes" },
        () => reviewTechnician(ports, id)
      )
    } catch (error) {
      await step.do("record repair failure", { retries }, () =>
        failTechnician(
          ports,
          id,
          error instanceof Error ? error.message : String(error)
        )
      )
    }
    // Explicit approval is a separate Dispatcher command; no browser is needed for execution.
    return (await ports.store.repair(id))?.value
  }
}
