import type { CommitId, RepoId } from "@terminus/domain"
import type {
  RepositoryContext,
  RepositoryFile,
  RepositoryOverview,
} from "@terminus/protocol"

export interface RepoRef {
  repoId: RepoId
  headCommit: CommitId
}

export interface IntegrationMergeInput {
  purpose?: "terminus" | "crossing"
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
  readContext(repoId: RepoId, commit: CommitId): Promise<RepositoryContext>
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
  /** Persists a merge candidate separately from both Terminus and the Train. */
  prepareIntegration(input: IntegrationMergeInput): Promise<IntegrationMerge>
  /** Creates the canonical Terminus repository for a new project. */
  createTerminus(input: { name: string; sourceUrl?: string }): Promise<RepoRef>

  /** Forks `sourceRepoId` at `commit` into a new repository. */
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
