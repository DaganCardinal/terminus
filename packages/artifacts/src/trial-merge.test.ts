import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import type { GitWorkspace, RepositoryAccess } from "./git"
import { checkoutTrialMerge } from "./trial-merge"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  )
})

/** Terminus, then two Trains forked from it, each with one accepted Car. */
async function fixture(conflict: boolean) {
  const root = await mkdtemp(join(tmpdir(), "terminus-trial-merge-"))
  temporary.push(root)
  const run = async (args: string[], cwd: string) =>
    (await execute("git", args, { cwd })).stdout.trim()
  const terminus = join(root, "terminus")
  await mkdir(terminus)
  await run(["init", "-b", "main"], terminus)
  await run(["config", "user.name", "Test"], terminus)
  await run(["config", "user.email", "test@localhost"], terminus)
  await writeFile(join(terminus, "shared.ts"), "baseline\n")
  await run(["add", "."], terminus)
  await run(["commit", "-m", "Baseline"], terminus)
  const train = async (name: string, file: string, content: string) => {
    const path = join(root, name)
    await run(["clone", terminus, path], root)
    await run(["config", "user.name", "Test"], path)
    await run(["config", "user.email", "test@localhost"], path)
    await writeFile(join(path, file), content)
    await run(["add", "."], path)
    await run(["commit", "-m", `${name} Car`], path)
    return { path, commit: await run(["rev-parse", "HEAD"], path) }
  }
  const a = await train("a", "shared.ts", "line A\n")
  const b = await train("b", conflict ? "shared.ts" : "other.ts", "line B\n")
  const access = (repoId: string, remote: string): RepositoryAccess => ({
    repoId,
    remote,
    scope: "read",
    branch: "main",
    token: "test",
    tokenId: "test",
  })
  const workspacePath = join(root, "workspace")
  await mkdir(workspacePath)
  const translate = (s: string) =>
    s.startsWith("/workspace") ? s.replace("/workspace", workspacePath) : s
  const workspace: GitWorkspace = {
    close: async () => {},
    run: async (command, cwd = "/workspace", env = {}) => {
      try {
        return {
          exitCode: 0,
          ...(await execute(command[0]!, command.slice(1).map(translate), {
            cwd: translate(cwd),
            env: { ...process.env, ...env },
          })),
        }
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string }
        return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr }
      }
    },
  }
  return {
    workspace,
    repo: join(workspacePath, "repo"),
    train: { access: access("a", a.path), commit: a.commit },
    other: { access: access("b", b.path), commit: b.commit },
  }
}

it("leaves both Trains' changes in the checkout when they merge cleanly", async () => {
  const f = await fixture(false)
  expect(await checkoutTrialMerge(f.workspace, f.train, f.other)).toEqual({
    clean: true,
    conflictPaths: [],
  })
  expect(await readFile(join(f.repo, "shared.ts"), "utf8")).toBe("line A\n")
  expect(await readFile(join(f.repo, "other.ts"), "utf8")).toBe("line B\n")
})

it("reports conflicted files and keeps their markers for the investigation", async () => {
  const f = await fixture(true)
  expect(await checkoutTrialMerge(f.workspace, f.train, f.other)).toEqual({
    clean: false,
    conflictPaths: ["shared.ts"],
  })
  expect(await readFile(join(f.repo, "shared.ts"), "utf8")).toContain("<<<<<<<")
})
