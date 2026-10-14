import {
  git,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"
import { sealedDirectory } from "./sealed-workspace"

/**
 * Merges `other` into `train` in the sealed checkout directory without
 * committing, so a read-only role can examine the combined result. When the
 * merge conflicts, the conflicted files keep their markers. Nothing is pushed.
 */
export async function checkoutTrialMerge(
  workspace: GitWorkspace,
  train: { access: RepositoryAccess; commit: string },
  other: { access: RepositoryAccess; commit: string }
): Promise<{ clean: boolean; conflictPaths: string[] }> {
  requireCommit(train.commit)
  requireCommit(other.commit)
  // Full history: the merge needs the Terminus commit both Trains forked from.
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    train.access.remote,
    sealedDirectory,
  ])
  await git(workspace, ["checkout", "--detach", train.commit], sealedDirectory)
  await git(
    workspace,
    ["fetch", "--no-tags", "--", other.access.remote, other.commit],
    sealedDirectory
  )
  const merged = await workspace.run(
    [
      "git",
      "-c",
      "user.name=Terminus",
      "-c",
      "user.email=terminus@localhost",
      "merge",
      "--no-commit",
      "--no-ff",
      other.commit,
    ],
    sealedDirectory
  )
  if (merged.exitCode === 0) return { clean: true, conflictPaths: [] }
  const conflictPaths = (
    await git(
      workspace,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      sealedDirectory
    )
  )
    .split("\0")
    .filter(Boolean)
  if (!conflictPaths.length)
    throw new Error("Trial merge failed without conflict evidence")
  return { clean: false, conflictPaths }
}
