/** Infrastructure implements this command boundary; this package owns Git. */
export interface GitWorkspace {
  run(
    command: string[],
    cwd?: string,
    env?: Record<string, string>
  ): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    outputTruncated?: boolean
  }>
  /** Installs project dependencies in `cwd`, when the workspace can do it faster than `npm ci`. */
  install?(cwd: string): ReturnType<GitWorkspace["run"]>
  close(): Promise<void>
}

export interface RepositoryAccess {
  repoId: string
  remote: string
  branch: string
  /** Ephemeral. Never log, persist, or place in a remote URL. */
  token: string
  tokenId: string
  scope: "read" | "write"
}

export interface GitWorkspaceFactory {
  open(access: RepositoryAccess[]): Promise<GitWorkspace>
}

export class RepositoryMovedError extends Error {}

export async function git(
  workspace: GitWorkspace,
  args: string[],
  cwd = "/workspace"
): Promise<string> {
  const result = await workspace.run(["git", ...args], cwd)
  if (result.exitCode !== 0)
    throw new Error(`Git ${args[0]} failed (exit ${result.exitCode})`)
  if (result.outputTruncated)
    throw new Error(`Git ${args[0]} output exceeded the capture limit`)
  return result.stdout
}

export function requireCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value))
    throw new Error("Expected a full Git commit identity")
  return value
}

/**
 * A detached checkout of one exact commit, for roles that never use history.
 * The commit is usually the default-branch tip, so a depth-1 clone suffices;
 * otherwise the full history is cloned, as before.
 */
export async function checkoutExactCommit(
  workspace: GitWorkspace,
  remote: string,
  commit: string,
  directory: string
): Promise<void> {
  requireCommit(commit)
  await git(workspace, [
    "clone",
    "--depth",
    "1",
    "--no-checkout",
    "--",
    remote,
    directory,
  ])
  const tip = (await git(workspace, ["rev-parse", "HEAD"], directory)).trim()
  if (tip !== commit) {
    const removed = await workspace.run(["rm", "-rf", "--", directory])
    if (removed.exitCode !== 0)
      throw new Error("Could not replace the shallow checkout")
    await git(workspace, ["clone", "--no-checkout", "--", remote, directory])
  }
  await git(workspace, ["checkout", "--detach", commit], directory)
  if (
    (await git(workspace, ["rev-parse", "HEAD"], directory)).trim() !== commit
  )
    throw new Error("Checkout did not match the requested commit")
}

export async function remoteHead(
  workspace: GitWorkspace,
  access: RepositoryAccess
): Promise<string | null> {
  const output = await git(workspace, [
    "ls-remote",
    "--",
    access.remote,
    `refs/heads/${access.branch}`,
  ])
  const hash = output.trim().split(/\s+/)[0]
  return hash ? requireCommit(hash) : null
}
