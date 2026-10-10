import {
  terminusPreviewSchema,
  type NetworkSummary,
  type TerminusPreview,
} from "@terminus/protocol"
import { NetworkStore } from "./network-store"
import {
  haltRepositoryPreview,
  launchRepositoryPreview,
  prepareRepositoryPreview,
  PreviewError,
  type PreviewRepositories,
  type PreviewSandbox,
} from "./repository-preview"

function snapshotFor(network: NetworkSummary, commit: string) {
  if (network.terminusCommit !== commit)
    throw new PreviewError(
      409,
      "Terminus changed. Refresh the network and preview its current commit."
    )
  return snapshotAt(network, commit)
}

function snapshotAt(network: NetworkSummary, commit: string) {
  return {
    identity: `terminus:${network.id}`,
    repoId: network.terminusRepoId,
    commit,
  }
}

export async function prepareTerminusPreview(
  network: NetworkSummary,
  commit: string,
  base: URL,
  repositories: PreviewRepositories,
  sandboxFor: (name: string) => PreviewSandbox
): Promise<TerminusPreview> {
  return terminusPreviewSchema.parse({
    networkId: network.id,
    ...(await prepareRepositoryPreview(
      snapshotFor(network, commit),
      base,
      repositories,
      sandboxFor
    )),
  })
}

export async function launchTerminusPreview(
  request: Request,
  env: Env,
  networkId: string,
  commit: string
): Promise<TerminusPreview> {
  const network = await new NetworkStore(env.DB).network(networkId)
  if (!network) throw new PreviewError(404, "Unknown network")
  return terminusPreviewSchema.parse({
    networkId,
    ...(await launchRepositoryPreview(
      request,
      env,
      snapshotFor(network, commit),
      "Terminus"
    )),
  })
}

/** Unlike starting, stopping accepts an older commit: a preview of it may
 * still be running after a canonical promotion. */
export async function stopTerminusPreview(
  env: Env,
  networkId: string,
  commit: string
): Promise<void> {
  const network = await new NetworkStore(env.DB).network(networkId)
  if (!network) throw new PreviewError(404, "Unknown network")
  await haltRepositoryPreview(env, snapshotAt(network, commit), "Terminus")
}
