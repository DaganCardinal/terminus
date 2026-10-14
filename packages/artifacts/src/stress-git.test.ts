import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { it, expect } from "vitest"
import { stressFiles } from "@terminus/protocol"
import {
  checkStressFiles,
  StressGitMismatchError,
  verifyStressGit,
  writeStressFiles,
} from "./stress-git"
import type { GitWorkspace, RepositoryAccess } from "./git"

const exec = promisify(execFile)

it("writes and checks fixture files with real node, repeats revisions, and refuses symlinks or other contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminus-stress-files-"))
  const workspace: GitWorkspace = {
    run: async (command, cwd) => {
      try {
        return {
          exitCode: 0,
          ...(await exec(command[0]!, command.slice(1), { cwd })),
        }
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) }
      }
    },
    close: async () => {},
  }
  const runId = "00000000-0000-4000-8000-000000000006"
  const files = stressFiles({ runId, train: 3 })
  const [checkpoint] = Object.keys(files)
  try {
    const checkout = join(root, "checkout")
    await mkdir(checkout)
    await writeStressFiles(workspace, files, checkout)
    await checkStressFiles(workspace, files, checkout)
    // A revision starts from the earlier candidate, which already holds the files.
    await writeStressFiles(workspace, files, checkout)
    await checkStressFiles(workspace, files, checkout)
    await writeFile(join(checkout, checkpoint!), "tampered\n")
    await expect(writeStressFiles(workspace, files, checkout)).rejects.toThrow(
      "Scripted stress edit failed"
    )
    await expect(checkStressFiles(workspace, files, checkout)).rejects.toThrow(
      "independent fixture verification"
    )
    const linked = join(root, "linked")
    await mkdir(join(linked, "src"), { recursive: true })
    await symlink(root, join(linked, "src/terminus-stress"))
    await expect(writeStressFiles(workspace, files, linked)).rejects.toThrow(
      "Scripted stress edit failed"
    )
    const linkedFile = join(root, "linked-file")
    await mkdir(linkedFile)
    await writeStressFiles(workspace, files, linkedFile)
    await rm(join(linkedFile, checkpoint!))
    await symlink(join(checkout, checkpoint!), join(linkedFile, checkpoint!))
    await expect(
      writeStressFiles(workspace, files, linkedFile)
    ).rejects.toThrow("Scripted stress edit failed")
    await expect(
      checkStressFiles(workspace, files, linkedFile)
    ).rejects.toThrow("independent fixture verification")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
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
    const [first, second] = Object.keys(files).sort()
    const unrelated = await git(
      "commit-tree",
      "-m",
      "unrelated",
      `${baseline}^{tree}`
    )
    const mismatch = await verifyStressGit(workspace, access, {
      ...input,
      files: { ...files, [first!]: "corrupted\n", [second!]: "corrupted\n" },
      acceptedCommits: [...acceptedCommits.slice(1), unrelated],
    }).catch((error: unknown) => error)
    // Every difference is reported, not only the first.
    expect(mismatch).toBeInstanceOf(StressGitMismatchError)
    expect((mismatch as StressGitMismatchError).findings).toEqual([
      `Incorrect canonical stress file: ${first}`,
      `Incorrect canonical stress file: ${second}`,
      `Accepted Car commit ${unrelated} is not reachable from the canonical head`,
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
