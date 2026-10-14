import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { it, expect } from "vitest"
import { stressFiles } from "@terminus/protocol"
import { verifyStressGit } from "./stress-git"
import type { GitWorkspace, RepositoryAccess } from "./git"

const exec = promisify(execFile)
it("verifies actual ten-Train merge history, files and Car ancestry, and detects corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminus-stress-"))
  const repository = join(root, "canonical")
  const runId = "00000000-0000-4000-8000-000000000002"
  await mkdir(repository)
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: repository })).stdout.trim()
  const workspace: GitWorkspace = {
    run: async (command, cwd) => {
      // The fixture maps the Sandbox directory into its disposable local workspace.
      const args = command
        .slice(1)
        .map((arg) =>
          arg === "/workspace/stress-oracle" ? join(root, "oracle") : arg
        )
      try {
        const result = await exec(command[0]!, args, {
          cwd: cwd === "/workspace/stress-oracle" ? join(root, "oracle") : root,
        })
        return { exitCode: 0, ...result }
      } catch {
        return { exitCode: 1, stdout: "", stderr: "Git failed" }
      }
    },
    close: async () => {},
  }
  const access: RepositoryAccess = {
    remote: repository,
    repoId: "test/terminus",
    branch: "main",
    scope: "read",
    token: "",
    tokenId: "",
  }
  try {
    await git("init", "-b", "main")
    await git("config", "user.name", "Stress fixture")
    await git("config", "user.email", "stress@example.test")
    await writeFile(join(repository, "baseline.txt"), "baseline\n")
    await git("add", ".")
    await git("commit", "-m", "baseline")
    const baseline = await git("rev-parse", "HEAD")
    const files: Record<string, string> = {}
    const acceptedCommits: string[] = []
    const integrationCommits: string[] = []
    for (let train = 1; train <= 10; train++) {
      await git("checkout", "-b", `train-${train}`, baseline)
      const fixture = stressFiles({ runId, train })
      await mkdir(join(repository, "src/terminus-stress", runId), {
        recursive: true,
      })
      for (const [path, contents] of Object.entries(fixture))
        await writeFile(join(repository, path), contents)
      Object.assign(files, fixture)
      await git("add", ".")
      await git("commit", "-m", `checkpoint ${train}`)
      acceptedCommits.push(await git("rev-parse", "HEAD"))
      await git("checkout", "main")
      await git(
        "merge",
        "--no-ff",
        `train-${train}`,
        "-m",
        `integrate ${train}`
      )
    }
    integrationCommits.push(
      ...(await git("rev-list", "--min-parents=2", `${baseline}..HEAD`)).split(
        "\n"
      )
    )
    const input = {
      baseline,
      head: await git("rev-parse", "HEAD"),
      files,
      acceptedCommits,
      integrationCommits,
    }
    const result = await verifyStressGit(workspace, access, input)
    expect(result).toMatchObject({
      files: 20,
      reachableCars: 10,
      commit: input.head,
    })
    expect(result.mergeCommits).toHaveLength(10)
    await rm(join(root, "oracle"), { recursive: true })
    const first = Object.keys(files)[0]!
    await expect(
      verifyStressGit(workspace, access, {
        ...input,
        files: { ...files, [first]: "corrupted\n" },
      })
    ).rejects.toThrow("Incorrect canonical")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
