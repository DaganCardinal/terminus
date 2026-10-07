import type { CommitId, RepoId } from "@terminus/domain"
import type { RepositoryFile, RepositoryOverview } from "@terminus/protocol"

/**
 * Each Project owns one Artifacts namespace, and every repository the Project
 * uses (Terminus, Trains, Stations, candidates, Technician workspaces) lives
 * in it. A repository id is `<namespace>/<name>`.
 */
export function repoId(namespace: string, name: string): RepoId {
  return `${namespace}/${name}`
}

export function parseRepoId(id: RepoId): { namespace: string; name: string } {
  const [namespace, name, ...rest] = id.split("/")
  if (!namespace || !name || rest.length)
    throw new Error(`Repository id is not <namespace>/<name>: ${id}`)
  return { namespace, name }
}

/** A repository in the same namespace as `id`. Forks never leave their namespace. */
export function siblingRepoId(id: RepoId, name: string): RepoId {
  return repoId(parseRepoId(id).namespace, name)
}

/** Every Project's canonical repository has this name in its namespace. */
export const TERMINUS_REPO_NAME = "terminus"

export interface RepoRef {
  repoId: RepoId
  headCommit: CommitId
}

export interface IntegrationMergeInput {
  purpose?: "terminus" | "crossing" | "junction"
  id: string
  terminusRepoId: RepoId
  terminusCommit: CommitId
  trainRepoId: RepoId
  trainCommit: CommitId
  trainBaseline: CommitId
  acceptedCommits: CommitId[]
}

export type IntegrationMerge =
  { ok: true; candidate: RepoRef } | { ok: false; conflictPaths: string[] }

/**
 * The repository operations orchestration needs. Implementations own every
 * detail of Artifacts and Git; nothing outside this package sees them.
 */
export interface RepositoryHost {
  /** Independently verifies durable repair ancestry, scope and actual diffs. */
  inspectRepair(
    input: import("./technician-git").RepairGitInput,
    candidate: RepoRef
  ): Promise<{
    changedPaths: string[]
    diff: string
    repairPaths: string[]
    repairDiff: string
  }>
  /** A commit's file inventory and leading documents, for people browsing. */
  readOverview(repoId: RepoId, commit: CommitId): Promise<RepositoryOverview>
  /** One committed file, or null when the commit has none at `path`. */
  readFile(
    repoId: RepoId,
    commit: CommitId,
    path: string
  ): Promise<RepositoryFile | null>
  head(repoId: RepoId): Promise<CommitId>
  inspectIntegration?(
    input: IntegrationMergeInput,
    candidate: RepoRef
  ): Promise<{ diff: string; changedPaths: string[] }>
  /**
   * Persists a merge candidate separately from both Terminus and the Train,
   * named `input.id` in the target's namespace.
   */
  prepareIntegration(input: IntegrationMergeInput): Promise<IntegrationMerge>
  /** Creates the canonical Terminus repository in a new Project's namespace. */
  createTerminus(input: {
    namespace: string
    sourceUrl?: string
  }): Promise<RepoRef>

  /** Forks `sourceRepoId` at `commit` into `name` in the same namespace. */
  fork(input: {
    sourceRepoId: RepoId
    commit: CommitId
    name: string
  }): Promise<RepoRef>

  /**
   * Fast-forwards `targetRepoId` from `fromCommit` to `toCommit`, taking the
   * commits from `sourceRepoId`. Never forces. Succeeds without changes if the
   * target is already at `toCommit`, so a retried step is safe.
   */
  fastForward(input: {
    targetRepoId: RepoId
    sourceRepoId: RepoId
    fromCommit: CommitId
    toCommit: CommitId
  }): Promise<void>
}
