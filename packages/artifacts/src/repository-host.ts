import type { CommitId, RepoId } from "@terminus/domain"

export interface RepoRef {
  repoId: RepoId
  headCommit: CommitId
}

/**
 * The repository operations orchestration needs. Implementations own every
 * detail of Artifacts and Git; nothing outside this package sees them.
 */
export interface RepositoryHost {
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
