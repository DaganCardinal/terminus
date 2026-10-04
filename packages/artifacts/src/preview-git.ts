import { git, requireCommit, type GitWorkspace } from "./git"

/** Clone without changing any repository and pin the preview to the saved head. */
export async function checkoutPreview(
  workspace: GitWorkspace,
  remote: string,
  commit: string
): Promise<void> {
  requireCommit(commit)
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    remote,
    "/workspace/preview",
  ])
  await git(workspace, ["checkout", "--detach", commit], "/workspace/preview")
  const head = await git(workspace, ["rev-parse", "HEAD"], "/workspace/preview")
  if (head.trim() !== commit)
    throw new Error("Preview checkout did not match the Train commit")
}
