import { errorKind, perf } from "@terminus/protocol"
import { NetworkStore } from "./network-store"

export class NetworkUnavailableError extends Error {}

type WorkTable =
  | "trains"
  | "stations"
  | "dispatch_plans"
  | "technician_repairs"
  | "junctions"
  | "integration_attempts"

/** Fence both sides of creation: an HTTP request or cached Workflow step may
 * already be in flight when permanent deletion begins. */
export async function createWorkflow<T>(
  env: Env,
  binding: Workflow<T>,
  table: WorkTable,
  workId: string,
  options: WorkflowInstanceCreateOptions<T>
): Promise<WorkflowInstance> {
  // TEMPORARY benchmark instrumentation.
  const started = Date.now()
  try {
    const instance = await createWorkflowUntimed(
      env,
      binding,
      table,
      workId,
      options
    )
    perf("workflow.created", {
      table,
      workId,
      instance: options.id,
      ms: Date.now() - started,
    })
    return instance
  } catch (error) {
    perf("workflow.create_failed", {
      table,
      workId,
      instance: options.id,
      ms: Date.now() - started,
      error: errorKind(error),
    })
    throw error
  }
}

async function createWorkflowUntimed<T>(
  env: Env,
  binding: Workflow<T>,
  table: WorkTable,
  workId: string,
  options: WorkflowInstanceCreateOptions<T>
): Promise<WorkflowInstance> {
  const row = await env.DB.prepare(
    `SELECT network_id FROM ${table} WHERE id = ?`
  )
    .bind(workId)
    .first<{ network_id: string }>()
  if (!row) throw new NetworkUnavailableError("Work no longer exists")
  const store = new NetworkStore(env.DB)
  try {
    await store.assertActive(row.network_id)
  } catch (error) {
    throw new NetworkUnavailableError(String(error))
  }
  const instance = await binding.create(options)
  try {
    await store.assertActive(row.network_id)
  } catch (error) {
    await instance.delete()
    throw new NetworkUnavailableError(String(error))
  }
  return instance
}
