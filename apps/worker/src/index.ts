export { JunctionWorkflow } from "./workflows/junction-workflow"
import { handleApplication } from "./api/application"

export { TechnicianWorkflow } from "./workflows/technician-workflow"
export { StationWorkflow } from "./workflows/station-workflow"
export { TrainWorkflow } from "./workflows/train-workflow"
export { IntegrationWorkflow } from "./workflows/integration-workflow"
export { DispatchWorkflow } from "./workflows/dispatch-workflow"
export {
  ExecutionSandbox,
  WorkspaceSandbox,
} from "./integrations/execution-sandbox"
export { SandboxOutbound } from "./integrations/sandbox-outbound"

export default {
  fetch: handleApplication,
} satisfies ExportedHandler<Env>
