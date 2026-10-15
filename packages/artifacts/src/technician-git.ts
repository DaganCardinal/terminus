import type { RepairSource } from "@terminus/domain"
import {
  git,
  remoteHead,
  requireCommit,
  RepositoryMovedError,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"
import { secretFilePatches, withoutSecrets } from "./secret-diff"

export const technicianDirectory = "/workspace/repo"
export interface RepairGitInput {
  id: string
  source: RepairSource
  scope: string[]
  problem?: { kind: "conflict" | "checks" | "review"; id: string }
}

/** Orchestration owns the merge parents; the harness supplies only a resolved tree. */
export class TechnicianGit {
  private baselineTree = ""
  private readonly workspace: GitWorkspace
  private readonly candidate: RepositoryAccess
  private readonly train: RepositoryAccess
  private readonly input: RepairGitInput
  constructor(
    workspace: GitWorkspace,
    candidate: RepositoryAccess,
    train: RepositoryAccess,
    input: RepairGitInput
  ) {
    this.workspace = workspace
    this.candidate = candidate
    this.train = train
    this.input = input
  }

  async prepare(): Promise<string | null> {
    const { source, scope } = this.input
    for (const commit of [
      source.trainCommit,
      source.terminusCommit,
      source.trainBaseline,
      ...source.acceptedCommits,
    ])
      requireCommit(commit)
    if ((await remoteHead(this.workspace, this.train)) !== source.trainCommit)
      throw new RepositoryMovedError("Train moved before repair")
    await git(this.workspace, [
      "clone",
      "--no-checkout",
      "--",
      this.candidate.remote,
      technicianDirectory,
    ])
    await git(
      this.workspace,
      ["fetch", "--no-tags", "--", this.train.remote, source.trainCommit],
      technicianDirectory
    )
    const saved = requireCommit(
      (
        await git(this.workspace, ["rev-parse", "HEAD"], technicianDirectory)
      ).trim()
    )
    for (const [ancestor, descendant] of [
      [source.trainBaseline, source.terminusCommit],
      [source.trainBaseline, source.trainCommit],
      ...source.acceptedCommits.map((commit) => [commit, source.trainCommit]),
    ]) {
      const result = await this.workspace.run(
        ["git", "merge-base", "--is-ancestor", ancestor!, descendant!],
        technicianDirectory
      )
      if (result.exitCode !== 0)
        throw new RepositoryMovedError(
          "Repair lost accepted Train history or its baseline"
        )
    }
    await git(
      this.workspace,
      ["checkout", "--detach", source.terminusCommit],
      technicianDirectory
    )
    if (this.input.source.kind === "junction_feature") {
      this.baselineTree = requireCommit(
        (
          await git(
            this.workspace,
            ["rev-parse", `${source.terminusCommit}^{tree}`],
            technicianDirectory
          )
        ).trim()
      )
      if (saved !== source.terminusCommit) {
        await git(
          this.workspace,
          ["checkout", "--detach", saved],
          technicianDirectory
        )
        await this.snapshot(saved)
        return saved
      }
      return null
    }
    await this.merge()
    // Build a reference tree that contains every clean automatic merge result.
    // Only the conflicted files use Terminus's version, so scope comparisons
    // do not mistake clean incoming Train work for Technician edits.
    for (const path of this.input.problem?.kind &&
    this.input.problem.kind !== "conflict"
      ? []
      : scope) {
      const stages = await git(
        this.workspace,
        ["ls-files", "-u", "--", path],
        technicianDirectory
      )
      if (stages.split("\n").some((line) => /^\d+ [a-f0-9]+ 2\t/.test(line))) {
        await git(
          this.workspace,
          ["checkout", "--ours", "--", path],
          technicianDirectory
        )
        await git(this.workspace, ["add", "--", path], technicianDirectory)
      } else
        await git(
          this.workspace,
          ["rm", "--force", "--", path],
          technicianDirectory
        )
    }
    this.baselineTree = requireCommit(
      (await git(this.workspace, ["write-tree"], technicianDirectory)).trim()
    )
    await git(
      this.workspace,
      ["reset", "--hard", source.terminusCommit],
      technicianDirectory
    )
    if (saved !== source.terminusCommit) {
      await git(
        this.workspace,
        ["checkout", "--detach", saved],
        technicianDirectory
      )
      await this.snapshot(saved)
      return saved
    }
    await this.merge()
    return null
  }

  private async merge(): Promise<void> {
    const merged = await this.workspace.run(
      [
        "git",
        "-c",
        "user.name=Terminus",
        "-c",
        "user.email=terminus@localhost",
        "merge",
        "--no-commit",
        "--no-ff",
        this.input.source.trainCommit,
      ],
      technicianDirectory
    )
    const paths = (
      await git(
        this.workspace,
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        technicianDirectory
      )
    )
      .split("\0")
      .filter(Boolean)
    if (this.input.problem?.kind && this.input.problem.kind !== "conflict") {
      if (merged.exitCode !== 0 || paths.length)
        throw new RepositoryMovedError(
          "Check/review repair encountered an unrecorded conflict"
        )
      return
    }
    if (
      merged.exitCode === 0 ||
      !paths.length ||
      JSON.stringify([...paths].sort()) !==
        JSON.stringify([...this.input.scope].sort())
    )
      throw new RepositoryMovedError(
        "Repair no longer matches the recorded merge conflict"
      )
  }

  async candidateCommit(): Promise<string> {
    await git(this.workspace, ["add", "-A"], technicianDirectory)
    await git(
      this.workspace,
      ["diff", "--cached", "--check", "--", ...this.input.scope],
      technicianDirectory
    )
    const tree = requireCommit(
      (await git(this.workspace, ["write-tree"], technicianDirectory)).trim()
    )
    const commit = requireCommit(
      (
        await git(
          this.workspace,
          [
            "-c",
            "user.name=Terminus",
            "-c",
            "user.email=terminus@localhost",
            "commit-tree",
            tree,
            "-p",
            this.input.source.terminusCommit,
            ...(this.input.source.kind === "junction_feature"
              ? []
              : ["-p", this.input.source.trainCommit]),
            "-m",
            this.message(),
          ],
          technicianDirectory
        )
      ).trim()
    )
    await this.snapshot(commit)
    // Remove the unfinished merge and check out exactly the candidate tree.
    await git(this.workspace, ["reset", "--hard", commit], technicianDirectory)
    return commit
  }

  async snapshot(commit: string) {
    requireCommit(commit)
    const parents = (
      await git(
        this.workspace,
        ["show", "-s", "--format=%P", commit],
        technicianDirectory
      )
    ).trim()
    const message = (
      await git(
        this.workspace,
        ["show", "-s", "--format=%B", commit],
        technicianDirectory
      )
    ).trim()
    if (
      parents !==
        (this.input.source.kind === "junction_feature"
          ? this.input.source.terminusCommit
          : `${this.input.source.terminusCommit} ${this.input.source.trainCommit}`) ||
      message !== this.message()
    )
      throw new RepositoryMovedError(
        "Repair candidate has different merge provenance"
      )
    const repairPaths = (
      await git(
        this.workspace,
        ["diff", "--name-only", "-z", this.baselineTree, commit],
        technicianDirectory
      )
    )
      .split("\0")
      .filter(Boolean)
    if (repairPaths.some((path) => !this.input.scope.includes(path)))
      throw new Error("Technician edited outside the conflicted files")
    const changedPaths = (
      await git(
        this.workspace,
        ["diff", "--name-only", "-z", this.input.source.terminusCommit, commit],
        technicianDirectory
      )
    )
      .split("\0")
      .filter(Boolean)
    const diff = await this.patch(this.input.source.terminusCommit, commit)
    const repairDiff = await this.patch(this.baselineTree, commit)
    return { changedPaths, diff, repairPaths, repairDiff }
  }

  /** What a reviewer sees between two trees; secret files show no contents. */
  private async patch(base: string, head: string): Promise<string> {
    return (
      (await git(
        this.workspace,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          base,
          head,
          "--",
          ...withoutSecrets,
        ],
        technicianDirectory
      )) +
      (await secretFilePatches(this.workspace, base, head, technicianDirectory))
    )
  }

  async publish(commit: string): Promise<void> {
    const head = await remoteHead(this.workspace, this.candidate)
    if (head === commit) return
    if (head !== this.input.source.terminusCommit)
      throw new RepositoryMovedError(
        "Repair workspace moved before publication"
      )
    await git(
      this.workspace,
      [
        "push",
        "--",
        this.candidate.remote,
        `${requireCommit(commit)}:refs/heads/${this.candidate.branch}`,
      ],
      technicianDirectory
    )
    if ((await remoteHead(this.workspace, this.candidate)) !== commit)
      throw new Error("Repair candidate was not persisted")
  }

  private message() {
    return `Repair Train ${this.input.source.trainId}\n\nTerminus-Repair: ${this.input.id}`
  }
}
