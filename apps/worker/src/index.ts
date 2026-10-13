export { JunctionWorkflow } from "./workflows/junction-workflow"
import { handleApplication } from "./api/application"

export { TechnicianWorkflow } from "./workflows/technician-workflow"
export { StationWorkflow } from "./workflows/station-workflow"
export { TrainWorkflow } from "./workflows/train-workflow"
export { IntegrationWorkflow } from "./workflows/integration-workflow"
export { DispatchWorkflow } from "./workflows/dispatch-workflow"
export {
  ExecutionSandbox,
  ExecutionSandboxStandard1,
  ExecutionSandboxStandard2,
  ExecutionSandboxStandard3,
  WorkspaceSandbox,
  WorkspaceSandboxStandard1,
  WorkspaceSandboxStandard2,
  WorkspaceSandboxStandard3,
} from "./integrations/execution-sandbox"
export { SandboxOutbound } from "./integrations/sandbox-outbound"
export { BrowserCandidateOutbound } from "./integrations/browser-run"

export default {
  fetch: handleApplication,
} satisfies ExportedHandler<Env>
