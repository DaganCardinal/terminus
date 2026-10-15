import {
  git,
  remoteHead,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"
import { secretFilePatches, withoutSecrets } from "./secret-diff"

export const stationDirectory = "/workspace/repo"

/** Repository mechanics for a Station. Harness and validation policy live elsewhere. */
export class StationGit {
  readonly #workspace: GitWorkspace
  readonly #access: RepositoryAccess
  readonly #baseCommit: string

  constructor(
    workspace: GitWorkspace,
    access: RepositoryAccess,
    baseCommit: string
  ) {
    this.#workspace = workspace
    this.#access = access
    this.#baseCommit = requireCommit(baseCommit)
  }

  async prepare(): Promise<void> {
    const removed = await this.#workspace.run([
      "rm",
      "-rf",
      "--",
      stationDirectory,
    ])
    if (removed.exitCode !== 0)
      throw new Error("Could not prepare the Station workspace")
    await git(this.#workspace, [
      "clone",
      "--",
      this.#access.remote,
      stationDirectory,
    ])
    await git(
      this.#workspace,
      ["config", "user.name", "Terminus Station Agent"],
      stationDirectory
    )
    await git(
      this.#workspace,
      ["config", "user.email", "station@terminus.local"],
      stationDirectory
    )
    await this.descendsFromBase("HEAD")
  }

  /** Recover an interrupted push without deleting an unpushed local candidate. */
  async recover(head: string): Promise<void> {
    requireCommit(head)
    const local = await this.#workspace.run(
      ["git", "rev-parse", "--verify", "HEAD"],
      stationDirectory
    )
    if (local.exitCode !== 0 || local.stdout.trim() !== head)
      await this.prepare()
    if (
      (
        await git(this.#workspace, ["rev-parse", "HEAD"], stationDirectory)
      ).trim() !== head
    ) {
      throw new Error(
        "Interrupted Station candidate is unavailable; a new run is required"
      )
    }
    await this.descendsFromBase(head)
  }

  async candidate(message: string): Promise<string> {
    await git(this.#workspace, ["add", "--all"], stationDirectory)
    if (
      (
        await git(
          this.#workspace,
          ["diff", "--cached", "--name-only"],
          stationDirectory
        )
      ).trim()
    ) {
      await git(this.#workspace, ["commit", "-m", message], stationDirectory)
    }
    const head = requireCommit(
      (
        await git(this.#workspace, ["rev-parse", "HEAD"], stationDirectory)
      ).trim()
    )
    await this.descendsFromBase(head)
    return head
  }

  async snapshot(
    head: string
  ): Promise<{ changedPaths: string[]; diff: string }> {
    if (
      (
        await git(this.#workspace, ["rev-parse", "HEAD"], stationDirectory)
      ).trim() !== head ||
      (
        await git(this.#workspace, ["status", "--porcelain"], stationDirectory)
      ).trim()
    ) {
      throw new Error(
        "Validation changed the candidate; evidence no longer describes that commit"
      )
    }
    const changedPaths = (
      await git(
        this.#workspace,
        ["diff", "--name-only", "-z", this.#baseCommit, head],
        stationDirectory
      )
    )
      .split("\0")
      .filter(Boolean)
    const diff =
      (await git(
        this.#workspace,
        [
          "diff",
          "--binary",
          "--full-index",
          this.#baseCommit,
          head,
          "--",
          ...withoutSecrets,
        ],
        stationDirectory
      )) +
      (await secretFilePatches(
        this.#workspace,
        this.#baseCommit,
        head,
        stationDirectory
      ))
    if (diff.length > 200_000)
      throw new Error(
        "Station diff exceeds the review limit; split the manifest into smaller tasks"
      )
    return { changedPaths, diff }
  }

  async publish(head: string): Promise<void> {
    requireCommit(head)
    await git(
      this.#workspace,
      [
        "push",
        "--",
        this.#access.remote,
        `${head}:refs/heads/${this.#access.branch}`,
      ],
      stationDirectory
    )
    if ((await remoteHead(this.#workspace, this.#access)) !== head)
      throw new Error("Station remote did not reach the proposed commit")
  }

  private async descendsFromBase(head: string): Promise<void> {
    const ancestor = await this.#workspace.run(
      ["git", "merge-base", "--is-ancestor", this.#baseCommit, head],
      stationDirectory
    )
    if (ancestor.exitCode !== 0)
      throw new Error("Station history no longer descends from the Train base")
  }
}
