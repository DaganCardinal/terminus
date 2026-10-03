import type { RepositoryHost, RepoRef } from "./repository-host"

/**
 * A stateless stand-in for Artifacts. Repository ids are derived from names,
 * and forks start at the commit they were forked from. Use it for tests and
 * for running the network without touching real repositories.
 */
export class FakeRepositoryHost implements RepositoryHost {
  async createTerminus(input: { name: string }): Promise<RepoRef> {
    return { repoId: `fake-terminus-${input.name}`, headCommit: "fake-root" }
  }

  async fork(input: { commit: string; name: string }): Promise<RepoRef> {
    return { repoId: `fake-${input.name}`, headCommit: input.commit }
  }

  async fastForward(): Promise<void> {}
}
