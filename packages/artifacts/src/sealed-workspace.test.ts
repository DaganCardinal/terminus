import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { GitWorkspace, RepositoryAccess } from "./git"
import {
  changedSinceSeal,
  checkoutSealedWorkspace,
  sealWorkspace,
} from "./sealed-workspace"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "terminus-planning-test-"))
  temporary.push(directory)
  const source = join(directory, "source")
  await mkdir(source)
  const commit = async (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(source, path, ".."), { recursive: true })
      await writeFile(join(source, path), contents)
    }
    await execute("git", ["add", "-A"], { cwd: source })
    await execute(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"],
      { cwd: source }
    )
    return (
      await execute("git", ["rev-parse", "HEAD"], { cwd: source })
    ).stdout.trim()
  }
  await execute("git", ["init", "-q", "-b", "main"], { cwd: source })
  const root = join(directory, "workspace")
  await mkdir(root)
  const translate = (value: string) =>
    value.startsWith("/workspace") ? value.replace("/workspace", root) : value
  const workspace: GitWorkspace = {
    run: async (command, cwd = "/workspace") => {
      try {
        const output = await execute(
          command[0]!,
          command.slice(1).map(translate),
          {
            cwd: translate(cwd),
          }
        )
        return { exitCode: 0, ...output }
      } catch (error) {
        const failed = error as {
          code?: number
          stdout?: string
          stderr?: string
        }
        return {
          exitCode: typeof failed.code === "number" ? failed.code : 1,
          stdout: String(failed.stdout ?? ""),
          stderr: String(failed.stderr ?? ""),
        }
      }
    },
    close: async () => {},
  }
  const access: RepositoryAccess = {
    repoId: "p/terminus",
    remote: source,
    branch: "main",
    token: "unused",
    tokenId: "unused",
    scope: "read",
  }
  return { commit, workspace, access, repo: join(root, "repo") }
}

describe("sealed workspace", () => {
  it("checks out the exact commit, then removes committed secrets and history before a model reads it", async () => {
    const f = await fixture()
    const planned = await f.commit({
      "README.md": "planned",
      "src/App.tsx": "export {}",
      ".env": "SECRET=fixture-secret",
      "config/credentials.json": "{}",
    })
    await f.commit({ "README.md": "newer" })
    await checkoutSealedWorkspace(f.workspace, f.access, planned)
    expect(await readFile(join(f.repo, "README.md"), "utf8")).toBe("planned")
    await sealWorkspace(f.workspace)
    const files = await readdir(f.repo, { recursive: true })
    expect(files).toContain("src/App.tsx")
    expect(files).not.toContain(".env")
    expect(files).not.toContain("config/credentials.json")
    expect(files.some((path) => path.startsWith(".git"))).toBe(false)
  })

  it("reports tracked files a role changed after sealing, ignoring untracked output", async () => {
    const f = await fixture()
    const commit = await f.commit({
      "src/App.tsx": "export {}",
      "src/keep.ts": "export const keep = 1",
      ".env": "SECRET=fixture-secret",
    })
    await checkoutSealedWorkspace(f.workspace, f.access, commit)
    await sealWorkspace(f.workspace, { fingerprint: true })
    expect(await readdir(f.repo)).not.toContain(".git")
    expect(await changedSinceSeal(f.workspace)).toEqual({ count: 0, paths: [] })

    await mkdir(join(f.repo, "dist"))
    await writeFile(join(f.repo, "dist/index.js"), "built")
    expect(await changedSinceSeal(f.workspace)).toEqual({ count: 0, paths: [] })

    await writeFile(join(f.repo, "src/App.tsx"), "export const fixed = 1")
    await rm(join(f.repo, "src/keep.ts"))
    expect(await changedSinceSeal(f.workspace)).toEqual({
      count: 2,
      paths: ["src/App.tsx", "src/keep.ts"],
    })
  })

  it("refuses an abbreviated commit", async () => {
    const f = await fixture()
    await f.commit({ "README.md": "x" })
    await expect(
      checkoutSealedWorkspace(f.workspace, f.access, "abc123")
    ).rejects.toThrow("full Git commit")
  })
})
