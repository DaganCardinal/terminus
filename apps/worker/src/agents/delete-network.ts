import { ArtifactsRestClient } from "@terminus/artifacts"
import { NetworkDeletionStore } from "../integrations/network-deletion-store"
import { previewSandboxName } from "../integrations/repository-preview"
import { DispatchError } from "./dispatcher"

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
  const { network, namespace } = target
  const inventory = await store.inventory(networkId, namespace)
  const failures: { resource: string; action: string }[] = []
  for (const [binding, ids] of Object.entries(inventory.workflows)) {
    for (const id of ids) {
      try {
        let instance: WorkflowInstance
        try {
          instance =
            await env[binding as keyof typeof inventory.workflows].get(id)
        } catch (error) {
          if (missing(error)) continue
          throw error
        }
        if (
          !["complete", "errored", "terminated"].includes(
            (await instance.status()).status
          )
        ) {
          await instance.terminate()
          if (
            !["complete", "errored", "terminated"].includes(
              (await instance.status()).status
            )
          )
            throw new Error("Workflow has not stopped")
        }
        await instance.delete()
      } catch {
        failures.push({ resource: id, action: "stop and delete Workflow" })
      }
    }
  }
  if (env.REPOSITORY_MODE !== "fake") {
    // Named Station containers and historical previews may predate ownership
    // tracking. Collect them as well as every registered random session.
    const names = new Set(inventory.runIds.map((id) => `station-${id}`))
    const commits = new Set([
      network.terminusCommit,
      ...inventory.trains.map((train) => train.headCommit),
    ])
    for (const { event } of inventory.events) {
      for (const [key, value] of Object.entries(event))
        if (/commit$/i.test(key) && typeof value === "string")
          commits.add(value)
    }
    for (const commit of commits) {
      names.add(
        await previewSandboxName({
          identity: `terminus:${networkId}`,
          repoId: network.terminusRepoId,
          commit,
        })
      )
      for (const train of inventory.trains)
        names.add(
          await previewSandboxName({
            identity: train.id,
            repoId: train.repoId,
            commit,
          })
        )
    }
    const stubs = new Map(
      inventory.sandboxIds.map((id) => [
        id,
        env.SANDBOX.get(env.SANDBOX.idFromString(id)),
      ])
    )
    for (const name of names) {
      const stub = env.SANDBOX.getByName(name)
      stubs.set(stub.id.toString(), stub)
    }
    for (const [id, stub] of stubs) {
      try {
        await stub.purge()
      } catch {
        failures.push({ resource: id, action: "delete container" })
      }
    }
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
