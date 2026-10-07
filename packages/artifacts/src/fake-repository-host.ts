import {
  repoId,
  siblingRepoId,
  TERMINUS_REPO_NAME,
  type IntegrationMerge,
  type IntegrationMergeInput,
  type RepositoryHost,
  type RepoRef,
} from "./repository-host"
import { fakeRepositoryFiles } from "./fake-repository-files"
import { documentRank, isDocumentPath } from "./repository-browse"

const fakeEntries = Object.entries(fakeRepositoryFiles)
  .map(([path, content]) => ({
    path,
    size: new TextEncoder().encode(content).length,
  }))
  .sort((a, b) => a.path.localeCompare(b.path))

/**
 * A stateless stand-in for Artifacts. Repository ids follow the real
 * `<namespace>/<name>` scheme, and forks start at the commit they were forked
 * from. Use it for tests and
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
  async readOverview(_repoId: string, commit: string) {
    const documents = fakeEntries
      .filter((entry) => isDocumentPath(entry.path))
      .sort(
        (a, b) =>
          documentRank(a.path) - documentRank(b.path) ||
          a.path.localeCompare(b.path)
      )
      .map((entry) => ({
        path: entry.path,
        content: fakeRepositoryFiles[entry.path]!,
        truncated: false,
      }))
    return { commit, files: fakeEntries, filesTruncated: false, documents }
  }
  async readFile(_repoId: string, commit: string, path: string) {
    const content = fakeRepositoryFiles[path]
    const entry = fakeEntries.find((candidate) => candidate.path === path)
    return content === undefined || !entry
      ? null
      : { commit, path, size: entry.size, content, truncated: false }
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
        repoId: siblingRepoId(input.terminusRepoId, input.id),
        headCommit: `fake-merge-${input.id}`,
      },
    }
  }
  async inspectIntegration() {
    return { diff: "Fake Crossing merge diff", changedPaths: ["src/"] }
  }
  async createTerminus(input: { namespace: string }): Promise<RepoRef> {
    return {
      repoId: repoId(input.namespace, TERMINUS_REPO_NAME),
      headCommit: "fake-root",
    }
  }

  async fork(input: {
    sourceRepoId: string
    commit: string
    name: string
  }): Promise<RepoRef> {
    return {
      repoId: siblingRepoId(input.sourceRepoId, input.name),
      headCommit: input.commit,
    }
  }

  async fastForward(): Promise<void> {}
}
