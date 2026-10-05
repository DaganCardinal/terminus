import {
  git,
  remoteHead,
  RepositoryMovedError,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"
import type { IntegrationMerge, IntegrationMergeInput } from "./repository-host"

const directory = "/workspace/repo"

/** The candidate has canonical first-parent history and the accepted Train as its second parent. */
export async function prepareRepositoryMerge(
  workspace: GitWorkspace,
  candidate: RepositoryAccess,
  train: RepositoryAccess,
  spec: RepositoryMergeInput
): Promise<IntegrationMerge> {
  const input: IntegrationMergeInput = {
    id: spec.id,

    terminusRepoId: spec.targetRepoId,
    terminusCommit: spec.targetCommit,
    trainRepoId: spec.sourceRepoId,
    trainCommit: spec.sourceCommit,
    trainBaseline: spec.baseline ?? spec.targetCommit,
    acceptedCommits: spec.acceptedCommits,
  }
  if (
    spec.sourceMustMatchHead &&
    (await remoteHead(workspace, train)) !== input.trainCommit
  )
    throw new RepositoryMovedError("Train moved after Dispatcher clearance")
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    candidate.remote,
    directory,
  ])
  await git(
    workspace,
    ["fetch", "--no-tags", "--", train.remote, input.trainCommit],
    directory
  )
  const ancestor = async (older: string, newer: string) => {
    const result = await workspace.run(
      ["git", "merge-base", "--is-ancestor", older, newer],
      directory
    )
    if (result.exitCode > 1)
      throw new Error("Could not verify integration ancestry")
    return result.exitCode === 0
  }
  if (
    spec.sourceMustMatchHead &&
    (!(await ancestor(input.trainBaseline, input.terminusCommit)) ||
      !(await ancestor(input.trainBaseline, input.trainCommit)))
  )
    throw new RepositoryMovedError(
      "Integration no longer shares the Train's Terminus baseline"
    )
  if (!spec.sourceMustMatchHead) {
    const current = await remoteHead(workspace, train)
    if (!current)
      throw new RepositoryMovedError(
        "Source repository has no accepted history"
      )
    await git(
      workspace,
      ["fetch", "--no-tags", "--", train.remote, current],
      directory
    )
    if (!(await ancestor(input.trainCommit, current)))
      throw new RepositoryMovedError(
        "Checkpoint is no longer reachable from source history"
      )
  }
  for (const commit of input.acceptedCommits) {
    if (!(await ancestor(commit, input.trainCommit)))
      throw new RepositoryMovedError(
        "Train history no longer contains an accepted Car commit"
      )
  }
  const saved = requireCommit(
    (await git(workspace, ["rev-parse", "HEAD"], directory)).trim()
  )
  const message = `Integrate Train ${input.trainRepoId}\n\nTerminus-Integration: ${input.id}`
  if (saved !== input.terminusCommit) {
    const parents = (
      await git(workspace, ["show", "-s", "--format=%P", saved], directory)
    ).trim()
    const recorded = (
      await git(workspace, ["show", "-s", "--format=%B", saved], directory)
    ).trim()
    if (
      parents !== `${input.terminusCommit} ${input.trainCommit}` ||
      recorded !== message
    )
      throw new RepositoryMovedError(
        "Saved integration candidate has different provenance"
      )
    return { ok: true, candidate: { repoId: input.id, headCommit: saved } }
  }
  await git(
    workspace,
    ["checkout", "--detach", input.terminusCommit],
    directory
  )
  // A Train already contained by Terminus has nothing to merge. Validation
  // still runs, and its original accepted commits remain reachable.
  if (await ancestor(input.trainCommit, input.terminusCommit))
    return {
      ok: true,
      candidate: { repoId: input.id, headCommit: input.terminusCommit },
    }
  const merged = await workspace.run(
    [
      "git",
      "-c",
      "user.name=Terminus",
      "-c",
      "user.email=terminus@localhost",
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      message,
      input.trainCommit,
    ],
    directory
  )
  if (merged.exitCode !== 0) {
    const paths = (
      await git(
        workspace,
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        directory
      )
    )
      .split("\0")
      .filter(Boolean)
    if (paths.length === 0)
      throw new Error(
        "Integration merge failed without resolvable conflict evidence"
      )
    return { ok: false, conflictPaths: paths }
  }
  const headCommit = requireCommit(
    (await git(workspace, ["rev-parse", "HEAD"], directory)).trim()
  )
  await git(
    workspace,
    [
      "push",
      "--",
      candidate.remote,
      `${headCommit}:refs/heads/${candidate.branch}`,
    ],
    directory
  )
  if ((await remoteHead(workspace, candidate)) !== headCommit)
    throw new RepositoryMovedError("Integration candidate was not persisted")
  return { ok: true, candidate: { repoId: input.id, headCommit } }
}

/** Read-only checkout used for project-wide validation. */
export class IntegrationGit {
  private readonly workspace: GitWorkspace
  private readonly access: RepositoryAccess
  private readonly commit: string
  constructor(
    workspace: GitWorkspace,
    access: RepositoryAccess,
    commit: string
  ) {
    this.workspace = workspace
    this.access = access
    this.commit = commit
  }

  async checkout(): Promise<void> {
    requireCommit(this.commit)
    await git(this.workspace, [
      "clone",
      "--no-checkout",
      "--",
      this.access.remote,
      directory,
    ])
    await git(this.workspace, ["checkout", "--detach", this.commit], directory)
    await this.assertUnchanged()
  }

  async assertUnchanged(): Promise<void> {
    if (
      (await git(this.workspace, ["rev-parse", "HEAD"], directory)).trim() !==
        this.commit ||
      (await git(this.workspace, ["status", "--porcelain"], directory)).trim()
    )
      throw new Error(
        "Validation changed the integration candidate; evidence no longer describes its commit"
      )
  }
}

export interface RepositoryMergeInput {
  id: string
  targetRepoId: string
  targetCommit: string
  sourceRepoId: string
  sourceCommit: string
  acceptedCommits: string[]
  sourceMustMatchHead: boolean
  baseline?: string
}
export function prepareMerge(
  workspace: GitWorkspace,
  candidate: RepositoryAccess,
  source: RepositoryAccess,
  input: IntegrationMergeInput
): Promise<IntegrationMerge> {
  return prepareRepositoryMerge(workspace, candidate, source, {
    id: input.id,
    targetRepoId: input.terminusRepoId,
    targetCommit: input.terminusCommit,
    sourceRepoId: input.trainRepoId,
    sourceCommit: input.trainCommit,
    acceptedCommits: input.acceptedCommits,
    sourceMustMatchHead: input.purpose !== "crossing",
    baseline: input.trainBaseline,
  })
}
