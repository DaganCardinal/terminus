import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { checkoutPreview } from "./preview-git"
import type { GitWorkspace } from "./git"

const execute = promisify(execFile)

it("checks out the exact accepted commit even after the remote advances, without moving the remote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminus-preview-test-"))
  const repo = join(directory, "train")
  const run = async (args: string[], cwd = directory) =>
    (await execute("git", args, { cwd })).stdout.trim()
  try {
    await run(["init", "-b", "main", repo])
    await run(["config", "user.name", "Test"], repo)
    await run(["config", "user.email", "test@example.test"], repo)
    await writeFile(join(repo, "app.txt"), "accepted")
    await run(["add", "."], repo)
    await run(["commit", "-m", "Accepted"], repo)
    const accepted = await run(["rev-parse", "HEAD"], repo)
    await writeFile(join(repo, "app.txt"), "later")
    await run(["commit", "-am", "Later"], repo)
    const latest = await run(["rev-parse", "HEAD"], repo)
    const workspace: GitWorkspace = {
      run: async (command, cwd) => {
        const result = await execute(
          command[0]!,
          command.slice(1).map((arg) => arg.replace("/workspace", directory)),
          { cwd: cwd?.replace("/workspace", directory) ?? directory }
        )
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      },
      close: async () => {},
    }
    await checkoutPreview(workspace, repo, accepted)
    expect(
      await run(["show", "HEAD:app.txt"], join(directory, "preview"))
    ).toBe("accepted")
    expect(await run(["rev-parse", "HEAD"], repo)).toBe(latest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
