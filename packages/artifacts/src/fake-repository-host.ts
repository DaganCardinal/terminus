import type {
  IntegrationMerge,
  IntegrationMergeInput,
  RepositoryHost,
  RepoRef,
} from "./repository-host"

/**
 * A stateless stand-in for Artifacts. Repository ids are derived from names,
 * and forks start at the commit they were forked from. Use it for tests and
 * for running the network without touching real repositories.
 */
export class FakeRepositoryHost implements RepositoryHost {
  private readonly conflictPaths: string[]
  constructor(conflictPaths: string[] = []) {
    this.conflictPaths = conflictPaths
  }
  async inspectRepair(input: import("./technician-git").RepairGitInput) {
    return {
      changedPaths: input.scope,
      diff: "Fake integration diff",
      repairPaths: input.scope,
      repairDiff: "Fake reconciliation diff",
    }
  }
  async readContext(_repoId: string, commit: string) {
    return {
      commit,
      paths: [
        "src/App.tsx",
        "src/components/theme-provider.tsx",
        "package.json",
      ],
      pathsTruncated: false,
      files: [],
    }
  }
  async head(): Promise<string> {
    return "fake-root"
  }
  async prepareIntegration(
    input: IntegrationMergeInput
  ): Promise<IntegrationMerge> {
    if (this.conflictPaths.length)
      return { ok: false, conflictPaths: this.conflictPaths }
    return {
      ok: true as const,
      candidate: {
        repoId: `fake-${input.id}`,
        headCommit: `fake-merge-${input.id}`,
      },
    }
  }
  async createTerminus(input: { name: string }): Promise<RepoRef> {
    return { repoId: `fake-terminus-${input.name}`, headCommit: "fake-root" }
  }

  async fork(input: { commit: string; name: string }): Promise<RepoRef> {
    return { repoId: `fake-${input.name}`, headCommit: input.commit }
  }

  async fastForward(): Promise<void> {}
}
