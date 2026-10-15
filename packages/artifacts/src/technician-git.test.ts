import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { TechnicianGit, type RepairGitInput } from "./technician-git"
import type { GitWorkspace, RepositoryAccess } from "./git"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})
async function fixture(
  deletion = false,
  mode: "conflict" | "checks" | "feature" = "conflict",
  trainSecret = false
) {
  const root = await mkdtemp(join(tmpdir(), "terminus-technician-git-"))
  temporary.push(root)
  const origin = join(root, "origin")
  await mkdir(origin)
  const run = async (args: string[], cwd = origin) =>
    (await execute("git", args, { cwd })).stdout.trim()
  await run(["init", "-b", "main"])
  await run(["config", "user.name", "Test"])
  await run(["config", "user.email", "test@localhost"])
  await writeFile(join(origin, "shared.ts"), "export const shared = 'base'\n")
  await writeFile(join(origin, "untouched.ts"), "preserve me\n")
  await run(["add", "."])
  await run(["commit", "-m", "Baseline"])
  const baseline = await run(["rev-parse", "HEAD"])
  await run(["checkout", "-b", "train"])
  await writeFile(join(origin, "shared.ts"), "export const shared = 'train'\n")
  await writeFile(join(origin, "train-only.ts"), "accepted Train work\n")
  if (trainSecret) await writeFile(join(origin, ".env"), "API_KEY=train\n")
  await run(["add", "."])
  await run(["commit", "-m", "Accepted Car"])
  const trainCommit = await run(["rev-parse", "HEAD"])
  const trainRemote = join(root, "train.git")
  await run(["clone", "--bare", "--", origin, trainRemote])
  await run([
    "--git-dir",
    trainRemote,
    "symbolic-ref",
    "HEAD",
    "refs/heads/train",
  ])
  await run(["checkout", "main"])
  if (deletion) await run(["rm", "shared.ts"])
  else if (mode === "conflict")
    await writeFile(
      join(origin, "shared.ts"),
      "export const shared = 'terminus'\n"
    )
  if (mode !== "conflict")
    await writeFile(join(origin, "independent.ts"), "independent work\n")
  await run(["add", "."])
  await run(["commit", "-m", "Concurrent Terminus work"])
  const terminusCommit = await run(["rev-parse", "HEAD"])
  const candidateRemote = join(root, "candidate.git")
  await run(["clone", "--bare", "--", origin, candidateRemote])
  await run([
    "--git-dir",
    candidateRemote,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ])
  const candidate: RepositoryAccess = {
    repoId: "repair",
    remote: candidateRemote,
    branch: "main",
    token: "candidate",
    tokenId: "candidate",
    scope: "write",
  }
  const train: RepositoryAccess = {
    ...candidate,
    repoId: "train",
    remote: trainRemote,
    branch: "train",
    token: "read-train",
    tokenId: "read-train",
    scope: "read",
  }
  const input: RepairGitInput = {
    id: "repair",
    scope: ["shared.ts"],
    source: {
      integrationId: "failed",
      trainId: "train",
      trainRepoId: "train",
      trainCommit,
      trainBaseline: baseline,
      terminusRepoId: "terminus",
      terminusCommit,
      acceptedCommits: [trainCommit],
    },
  }
  if (mode === "feature") {
    input.source.kind = "junction_feature"
    input.source.junctionId = "j"
    input.source.trainCommit = terminusCommit
    input.source.acceptedCommits = [terminusCommit]
    await run(["--git-dir", trainRemote, "fetch", "--", origin, terminusCommit])
    await run([
      "--git-dir",
      trainRemote,
      "update-ref",
      "refs/heads/train",
      terminusCommit,
    ])
  }
  if (mode !== "conflict")
    input.problem = { kind: "checks", id: "feature-failed" }
  let counter = 0
  async function workspace() {
    const path = join(root, `workspace-${++counter}`)
    await mkdir(path)
    const translate = (value: string) =>
      value.startsWith("/workspace") ? value.replace("/workspace", path) : value
    const work: GitWorkspace = {
      run: async (command, cwd = "/workspace", env = {}) => {
        try {
          return {
            exitCode: 0,
            ...(await execute(command[0]!, command.slice(1).map(translate), {
              cwd: translate(cwd),
              env: { ...process.env, ...env },
              maxBuffer: 2_000_000,
            })),
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            !("stdout" in error) ||
            !("stderr" in error)
          )
            throw error
          return {
            exitCode: typeof error.code === "number" ? error.code : 1,
            stdout: String(error.stdout),
            stderr: String(error.stderr),
          }
        }
      },
      close: async () => {},
    }
    return {
      path: join(path, "repo"),
      git: new TechnicianGit(work, candidate, train, input),
      work,
    }
  }
  return { root, origin, run, workspace, input, candidateRemote, trainRemote }
}

describe("Technician Git reconciliation", () => {
  it("persists an exact two-parent merge, preserves Cars and clean Train changes, and recovers it", async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    expect(await workspace.git.prepare()).toBeNull()
    await writeFile(
      join(workspace.path, "shared.ts"),
      "export const shared = ['terminus', 'train']\n"
    )
    const commit = await workspace.git.candidateCommit()
    await workspace.git.publish(commit)
    const snapshot = await workspace.git.snapshot(commit)
    expect(snapshot.repairPaths).toEqual(["shared.ts"])
    expect(snapshot.changedPaths).toEqual(["shared.ts", "train-only.ts"])
    expect(
      await f.run(["show", "-s", "--format=%P", commit], workspace.path)
    ).toBe(`${f.input.source.terminusCommit} ${f.input.source.trainCommit}`)
    expect(
      await f.run(["show", `${commit}:train-only.ts`], workspace.path)
    ).toBe("accepted Train work")
    expect(
      await f.run(["--git-dir", f.trainRemote, "rev-parse", "train"])
    ).toBe(f.input.source.trainCommit)
    const fresh = await f.workspace()
    expect(await fresh.git.prepare()).toBe(commit)
    expect(await fresh.git.snapshot(commit)).toEqual(snapshot)
  })
  it("withholds secret file contents from the repair diffs", async () => {
    const f = await fixture(false, "conflict", true)
    const workspace = await f.workspace()
    expect(await workspace.git.prepare()).toBeNull()
    await writeFile(
      join(workspace.path, "shared.ts"),
      "export const shared = ['terminus', 'train']\n"
    )
    const snapshot = await workspace.git.snapshot(
      await workspace.git.candidateCommit()
    )
    expect(snapshot.changedPaths).toEqual([
      ".env",
      "shared.ts",
      "train-only.ts",
    ])
    expect(snapshot.diff).toContain("+accepted Train work")
    expect(snapshot.diff).toContain(
      "diff --git a/.env b/.env\nnew file mode 100644\nSecret file contents withheld\n"
    )
    expect(snapshot.diff).not.toContain("API_KEY")
    expect(snapshot.repairPaths).toEqual(["shared.ts"])
    expect(snapshot.repairDiff).not.toContain(".env")
  })
  it("rejects edits outside the conflicted files before publication", async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    await workspace.git.prepare()
    await writeFile(join(workspace.path, "shared.ts"), "resolved\n")
    await writeFile(
      join(workspace.path, "untouched.ts"),
      "unauthorized change\n"
    )
    await expect(workspace.git.candidateCommit()).rejects.toThrow("outside")
    expect(
      await f.run(["--git-dir", f.candidateRemote, "rev-parse", "main"])
    ).toBe(f.input.source.terminusCommit)
  })
  it("rejects unresolved conflict markers", async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    await workspace.git.prepare()
    await expect(workspace.git.candidateCommit()).rejects.toThrow(
      "Git diff failed"
    )
  })
  it("rejects a moved Train and missing accepted Car ancestry", async () => {
    const f = await fixture()
    f.input.source.trainCommit = f.input.source.trainBaseline
    const workspace = await f.workspace()
    await expect(workspace.git.prepare()).rejects.toThrow("Train moved")
    f.input.source.trainCommit = f.input.source.acceptedCommits[0]!
    f.input.source.acceptedCommits = [f.input.source.terminusCommit]
    const other = await f.workspace()
    await expect(other.git.prepare()).rejects.toThrow("accepted Train history")
  })
  it("handles modify/delete conflicts while retaining both parent histories", async () => {
    const f = await fixture(true)
    const workspace = await f.workspace()
    await workspace.git.prepare()
    await writeFile(
      join(workspace.path, "shared.ts"),
      "reconciled deletion and modification\n"
    )
    const commit = await workspace.git.candidateCommit()
    await workspace.git.publish(commit)
    expect((await workspace.git.snapshot(commit)).repairPaths).toEqual([
      "shared.ts",
    ])
  })
})

it.each(["checks", "feature"] as const)(
  "bounds %s repairs while preserving reviewed source ancestry",
  async (mode) => {
    const f = await fixture(false, mode),
      w = await f.workspace()
    expect(await w.git.prepare()).toBeNull()
    await writeFile(
      join(w.path, "shared.ts"),
      "export const shared = 'repaired'\n"
    )
    const commit = await w.git.candidateCommit(),
      snapshot = await w.git.snapshot(commit)
    expect(snapshot.repairPaths).toEqual(["shared.ts"])
    const parents = await f.run(["show", "-s", "--format=%P", commit], w.path)
    expect(parents).toBe(
      mode === "feature"
        ? f.input.source.terminusCommit
        : `${f.input.source.terminusCommit} ${f.input.source.trainCommit}`
    )
    await w.git.publish(commit)
    const fresh = await f.workspace()
    expect(await fresh.git.prepare()).toBe(commit)
    expect(await fresh.git.snapshot(commit)).toEqual(snapshot)
  }
)
it("rejects check repairs that broaden repository scope", async () => {
  const f = await fixture(false, "checks"),
    w = await f.workspace()
  await w.git.prepare()
  await writeFile(join(w.path, "untouched.ts"), "out of scope\n")
  await expect(w.git.candidateCommit()).rejects.toThrow(/outside/)
})
