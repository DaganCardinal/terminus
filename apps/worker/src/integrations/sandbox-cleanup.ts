import type { StopStationSandboxRequest } from "@terminus/protocol"
import { NetworkStore } from "./network-store"

export class SandboxCleanupError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface SandboxCleanupPorts {
  store: Pick<NetworkStore, "station">
  runStatus(runId: string): Promise<string>
  unpublishedCandidate(runId: string): Promise<boolean>
  closeSandbox(name: string): Promise<void>
}

/** Infrastructure cleanup only: never changes Station or Train lifecycle state. */
export async function cleanupStationSandbox(
  ports: SandboxCleanupPorts,
  stationId: string,
  request: StopStationSandboxRequest
): Promise<void> {
  if (!(await ports.store.station(stationId)))
    throw new SandboxCleanupError(404, "Unknown Station")
  const prefix = `${stationId}-`
  if (
    !request.runId.startsWith(prefix) ||
    !/^s\d+-r\d+(?:-f\d+)?$/.test(request.runId.slice(prefix.length))
  )
    throw new SandboxCleanupError(400, "Run ID does not belong to this Station")

  let status: string
  try {
    status = await ports.runStatus(request.runId)
  } catch {
    throw new SandboxCleanupError(
      409,
      "Could not verify the Station Workflow has finished; check its status before cleanup"
    )
  }
  if (!["complete", "errored", "terminated"].includes(status))
    throw new SandboxCleanupError(
      409,
      `Station Workflow is ${status}; wait for it to finish or terminate it before cleanup`
    )
  if (
    !request.discardUnpublishedCandidate &&
    (await ports.unpublishedCandidate(request.runId))
  )
    throw new SandboxCleanupError(
      409,
      "Sandbox may contain an unpublished candidate needed for recovery; set discardUnpublishedCandidate to true only to discard that work"
    )
  await ports.closeSandbox(`station-${request.runId}`)
}

export async function stopStationSandbox(
  env: Env,
  stationId: string,
  request: StopStationSandboxRequest
): Promise<void> {
  await cleanupStationSandbox(
    {
      store: new NetworkStore(env.DB),
      runStatus: async (runId) =>
        (await (await env.STATION_WORKFLOW.get(runId)).status()).status,
      unpublishedCandidate: async (runId) =>
        !!(await env.DB.prepare(
          "SELECT id FROM agent_runs WHERE id = ? AND published = 0"
        )
          .bind(runId)
          .first()),
      closeSandbox: (name) => env.SANDBOX.getByName(name).close(),
    },
    stationId,
    request
  )
}
