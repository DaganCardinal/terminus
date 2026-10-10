import { checkoutExactCommit, type GitWorkspace } from "./git"

/** Clone without changing any repository and pin the preview to the saved head. */
export async function checkoutPreview(
  workspace: GitWorkspace,
  remote: string,
  commit: string
): Promise<void> {
  await checkoutExactCommit(workspace, remote, commit, "/workspace/preview")
}
