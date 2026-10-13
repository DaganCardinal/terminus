import {
  PUBLISH_REPO_NAME,
  RepositoryMovedError,
  siblingRepoId,
} from "@terminus/artifacts"
import type { NetworkId, TerminusPublication } from "@terminus/protocol"
import { DispatchError, type DispatcherPorts } from "./dispatcher"

export type PublishPorts = Pick<
  DispatcherPorts,
  "store" | "repositories" | "now"
>

/**
 * Publishes the displayed canonical commit to the network's publish
 * repository, which a deployment such as Workers Builds watches. The first
 * publish forks Terminus at that commit; later ones fast-forward, never
 * force. Publishing changes no railway state and reserves no clearance.
 */
export async function publishTerminus(
  ports: PublishPorts,
  networkId: NetworkId,
  commit: string
): Promise<TerminusPublication> {
  const network = await ports.store.network(networkId)
  if (!network) throw new DispatchError(404, "Unknown network")
  if (network.terminusCommit !== commit)
    throw new DispatchError(
      409,
      "Terminus changed. Refresh the network and publish its current commit."
    )
  const published = network.publication
  const repoId =
    published?.repoId ??
    siblingRepoId(network.terminusRepoId, PUBLISH_REPO_NAME)
  if (published?.commit === commit) return published

  try {
    if (published) await advance(ports, network.terminusRepoId, repoId, commit)
    else {
      try {
        await ports.repositories.fork({
          sourceRepoId: network.terminusRepoId,
          commit,
          name: PUBLISH_REPO_NAME,
        })
      } catch (error) {
        // An earlier publish created the repository but its record was lost.
        if (!(error instanceof RepositoryMovedError)) throw error
        await advance(ports, network.terminusRepoId, repoId, commit)
      }
    }
  } catch (error) {
    if (error instanceof RepositoryMovedError)
      throw new DispatchError(
        409,
        "The publish repository or Terminus moved during publishing. Refresh and publish again."
      )
    throw error
  }

  const publication = { repoId, commit, publishedAt: ports.now() }
  await ports.store.commit(
    networkId,
    [{ kind: "publication", publication }],
    [{ type: "terminus.published", commit }]
  )
  return {
    ...publication,
    ...(published?.siteUrl ? { siteUrl: published.siteUrl } : {}),
  }
}

/** Fast-forwards from whatever the publish repository serves now. Canonical
 * history only moves forward, so that is always an ancestor of `commit`. */
async function advance(
  ports: PublishPorts,
  terminusRepoId: string,
  repoId: string,
  commit: string
): Promise<void> {
  await ports.repositories.fastForward({
    targetRepoId: repoId,
    sourceRepoId: terminusRepoId,
    fromCommit: await ports.repositories.head(repoId),
    toCommit: commit,
  })
}
