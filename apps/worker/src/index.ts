import { handleApi } from "./api/router"
import { routeTrainPreview } from "./integrations/train-preview"

export { TechnicianWorkflow } from "./workflows/technician-workflow"
export { StationWorkflow } from "./workflows/station-workflow"
export { TrainWorkflow } from "./workflows/train-workflow"
export { IntegrationWorkflow } from "./workflows/integration-workflow"
export { DispatchWorkflow } from "./workflows/dispatch-workflow"
export { ExecutionSandbox } from "./integrations/execution-sandbox"
export { SandboxOutbound } from "./integrations/sandbox-outbound"

export default {
  async fetch(request, env) {
    const preview = await routeTrainPreview(request, env)
    if (preview) return preview
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return handleApi(request, env)
    }
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
