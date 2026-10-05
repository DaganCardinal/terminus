import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, it, expect } from "vitest"
import {
  prepareRepositoryMerge,
  type RepositoryMergeInput,
} from "./integration-git"
import type { GitWorkspace, RepositoryAccess } from "./git"
const execute = promisify(execFile),
  temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  )
})
async function fixture(conflict = false) {
  const root = await mkdtemp(join(tmpdir(), "terminus-crossing-git-"))
  temporary.push(root)
  const base = join(root, "base")
  await mkdir(base)
  const run = async (args: string[], cwd = base) =>
    (await execute("git", args, { cwd })).stdout.trim()
  await run(["init", "-b", "main"])
  await run(["config", "user.name", "Test"])
  await run(["config", "user.email", "test@localhost"])
  await writeFile(join(base, "shared.ts"), "baseline\n")
  await run(["add", "."])
  await run(["commit", "-m", "Baseline"])
  const baseline = await run(["rev-parse", "HEAD"])
  const source = join(root, "source")
  await run(["clone", base, source])
  await run(["config", "user.name", "Test"], source)
  await run(["config", "user.email", "test@localhost"], source)
  await writeFile(
    join(source, conflict ? "shared.ts" : "api.ts"),
    "accepted API\n"
  )
  await run(["add", "."], source)
  await run(["commit", "-m", "Source Station accepted"], source)
  const checkpoint = await run(["rev-parse", "HEAD"], source)
  await writeFile(join(source, "later.ts"), "not part of pickup\n")
  await run(["add", "."], source)
  await run(["commit", "-m", "Later Station"], source)
  const latest = await run(["rev-parse", "HEAD"], source)
  await writeFile(
    join(base, conflict ? "shared.ts" : "ui.ts"),
    "receiving work\n"
  )
  await run(["add", "."])
  await run(["commit", "-m", "Receiving Car"])
  const targetCommit = await run(["rev-parse", "HEAD"])
  const candidateRemote = join(root, "candidate.git")
  await run(["clone", "--bare", base, candidateRemote])
  const access = (
    repoId: string,
    remote: string,
    scope: "read" | "write"
  ): RepositoryAccess => ({
    repoId,
    remote,
    scope,
    branch: "main",
    token: "test",
    tokenId: "test",
  })
  const candidate = access("candidate", candidateRemote, "write"),
    sourceAccess = access("source", source, "read")
  let counter = 0
  const workspace = async (): Promise<GitWorkspace> => {
    const path = join(root, `workspace-${++counter}`)
    await mkdir(path)
    const translate = (s: string) =>
      s.startsWith("/workspace") ? s.replace("/workspace", path) : s
    return {
      close: async () => {},
      run: async (command, cwd = "/workspace", env = {}) => {
        try {
          return {
            exitCode: 0,
            ...(await execute(command[0]!, command.slice(1).map(translate), {
              cwd: translate(cwd),
              env: { ...process.env, ...env },
              maxBuffer: 2000000,
            })),
          }
        } catch (error) {
          const e = error as { code: number; stdout: string; stderr: string }
          return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr }
        }
      },
    }
  }
  const spec: RepositoryMergeInput = {
    id: "candidate",
    targetRepoId: "receiving",
    targetCommit,
    sourceRepoId: "source",
    sourceCommit: checkpoint,
    acceptedCommits: [checkpoint],
    sourceMustMatchHead: false,
    baseline,
  }
  return {
    run,
    source,
    sourceAccess,
    candidate,
    candidateRemote,
    workspace,
    spec,
    checkpoint,
    latest,
    targetCommit,
  }
}
it("merges an accepted checkpoint without importing later source work, preserves both histories and recovers the durable candidate", async () => {
  const f = await fixture()
  const result = await prepareRepositoryMerge(
    await f.workspace(),
    f.candidate,
    f.sourceAccess,
    f.spec
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error()
  const head = result.candidate.headCommit
  const paths = (
    await f.run([
      "--git-dir",
      f.candidateRemote,
      "ls-tree",
      "-r",
      "--name-only",
      head,
    ])
  ).split("\n")
  expect(paths).toContain("api.ts")
  expect(paths).toContain("ui.ts")
  expect(paths).not.toContain("later.ts")
  expect(
    await f.run([
      "--git-dir",
      f.candidateRemote,
      "show",
      "-s",
      "--format=%P",
      head,
    ])
  ).toBe(`${f.targetCommit} ${f.checkpoint}`)
  expect(await f.run(["rev-parse", "HEAD"], f.source)).toBe(f.latest)
  expect(
    await prepareRepositoryMerge(
      await f.workspace(),
      f.candidate,
      f.sourceAccess,
      f.spec
    )
  ).toEqual(result)
})
it("reports conflicts without promoting either Train", async () => {
  const f = await fixture(true),
    result = await prepareRepositoryMerge(
      await f.workspace(),
      f.candidate,
      f.sourceAccess,
      f.spec
    )
  expect(result).toEqual({ ok: false, conflictPaths: ["shared.ts"] })
  expect(
    await f.run(["--git-dir", f.candidateRemote, "rev-parse", "HEAD"])
  ).toBe(f.targetCommit)
  expect(await f.run(["rev-parse", "HEAD"], f.source)).toBe(f.latest)
})
it("retains the stricter latest-head requirement for Terminus", async () => {
  const f = await fixture()
  await expect(
    prepareRepositoryMerge(await f.workspace(), f.candidate, f.sourceAccess, {
      ...f.spec,
      sourceMustMatchHead: true,
    })
  ).rejects.toThrow("Train moved")
})

it("recognizes an already-present checkpoint through Git ancestry", async () => {
  const f = await fixture()
  const first = await prepareRepositoryMerge(
    await f.workspace(),
    f.candidate,
    f.sourceAccess,
    f.spec
  )
  if (!first.ok) throw new Error("Expected candidate")
  const result = await prepareRepositoryMerge(
    await f.workspace(),
    f.candidate,
    f.sourceAccess,
    {
      ...f.spec,
      targetCommit: first.candidate.headCommit,
    }
  )
  expect(result).toEqual(first)
  expect(
    await f.run(["--git-dir", f.candidateRemote, "rev-parse", "HEAD"])
  ).toBe(first.candidate.headCommit)
})
