import { git, type GitWorkspace, type RepositoryAccess } from "./git"
import { IntegrationGit } from "./integration-git"
import { isSecretPath } from "./repository-browse"

/** Where the Dispatcher explores the exact planning baseline. */
export const planningDirectory = "/workspace/repo"

/** A detached, read-only checkout of the exact Terminus commit being planned against. */
export async function checkoutPlanningBaseline(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string
): Promise<void> {
  await new IntegrationGit(workspace, access, commit).checkout()
}

/**
 * Removes committed secrets and Git history before a model can read the
 * checkout. History objects would otherwise still contain the secret blobs.
 */
export async function sealPlanningWorkspace(
  workspace: GitWorkspace
): Promise<void> {
  const secrets = (await git(workspace, ["ls-files", "-z"], planningDirectory))
    .split("\0")
    .filter((path) => path && isSecretPath(path))
  for (let i = 0; i < secrets.length; i += 100) {
    const removed = await workspace.run(
      ["rm", "-f", "--", ...secrets.slice(i, i + 100)],
      planningDirectory
    )
    if (removed.exitCode !== 0)
      throw new Error(
        "Could not remove secret files from the planning checkout"
      )
  }
  const history = await workspace.run(
    ["rm", "-rf", "--", ".git"],
    planningDirectory
  )
  if (history.exitCode !== 0)
    throw new Error("Could not remove history from the planning checkout")
}
