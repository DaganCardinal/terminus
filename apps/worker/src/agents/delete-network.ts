import { ArtifactsRestClient } from "@terminus/artifacts"
import { NetworkDeletionStore } from "../integrations/network-deletion-store"
import { DispatchError } from "./dispatcher"

/** Sandboxes purged at once. Each purge waits on a container stopping. */
const PURGE_CONCURRENCY = 6

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:instance\.not_found|instance (?:does not exist|not found))/i.test(
      error.message
    )
  )
}

/** Permanent removal is a Dispatcher command. It terminates the owners before
 * erasing their records; it never drives a Train through another lifecycle. */
export async function deleteNetwork(
  env: Env,
  networkId: string
): Promise<void> {
  const store = new NetworkDeletionStore(env.DB)
  const target = await store.begin(networkId)
  if (!target) return
  const { namespace } = target
  const inventory = await store.inventory(networkId, namespace)
  const failures: { resource: string; action: string }[] = []
  for (const [binding, ids] of Object.entries(inventory.workflows)) {
    for (const id of ids) {
      try {
        // Deleting stops a running instance, without rollback handlers, and
        // erases its state, so no separate terminate is needed.
        await (
          await env[binding as keyof typeof inventory.workflows].get(id)
        ).delete()
      } catch (error) {
        if (!missing(error))
          failures.push({ resource: id, action: "stop and delete Workflow" })
      }
    }
  }
  if (env.REPOSITORY_MODE !== "fake") {
    // Every Sandbox registers itself before its first container starts, so
    // the registry is the whole set to purge. Purging an address that never
    // ran wakes its Durable Objects for nothing, so none is guessed.
    const queue = [...inventory.sandboxes]
    await Promise.all(
      Array.from({ length: PURGE_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const { id, binding } = next
          try {
            await env[binding].get(env[binding].idFromString(id)).purge()
          } catch {
            failures.push({ resource: id, action: "delete container" })
          }
        }
      })
    )
  }
  if (failures.length)
    throw new DispatchError(
      503,
      "Network deletion is incomplete. New work is disabled. Retry Delete Network to finish cleanup.",
      failures
    )
  if (env.REPOSITORY_MODE !== "fake") {
    try {
      await new ArtifactsRestClient({
        accountId: env.ARTIFACTS_ACCOUNT_ID,
        apiToken: env.ARTIFACTS_API_TOKEN ?? "",
      }).deleteRepositories(namespace)
    } catch {
      throw new DispatchError(
        503,
        "Could not delete all network repositories. New work is disabled. Retry Delete Network to finish cleanup."
      )
    }
  }
  try {
    await store.erase(networkId, namespace)
  } catch {
    throw new DispatchError(
      503,
      "Could not erase all network records. New work is disabled. Retry Delete Network to finish cleanup."
    )
  }
}
