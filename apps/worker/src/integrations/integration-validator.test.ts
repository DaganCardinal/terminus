import { describe, expect, it, vi } from "vitest"
import type { GitWorkspace, RepositoryAccess } from "@terminus/artifacts"
import type { CommandResult } from "@terminus/protocol"
import { SandboxIntegrationValidator } from "./integration-validator"

const commit = "a".repeat(40)
const commands = [{ name: "test", command: ["npm", "test"] }]

function fixture(
  options: {
    installFails?: boolean
    testTruncated?: boolean
    dirty?: boolean
  } = {}
) {
  const access: RepositoryAccess = {
    repoId: "candidate",
    remote: "https://test.artifacts.cloudflare.net/git/default/candidate.git",
    branch: "main",
    scope: "read",
    token: "ephemeral",
    tokenId: "token",
  }
  let validated = false
  const run = vi.fn(async (command: string[]): Promise<CommandResult> => {
    if (command.includes("rev-parse"))
      return { exitCode: 0, stdout: commit, stderr: "" }
    if (command.includes("status"))
      return {
        exitCode: 0,
        stdout: validated && options.dirty ? " M tracked.ts\n" : "",
        stderr: "",
      }
    if (command[0] === "npm") {
      validated = true
      return {
        exitCode: command[1] === "ci" && options.installFails ? 1 : 0,
        stdout: "independent output",
        stderr: "",
        outputTruncated:
          (command[1] === "test" && options.testTruncated) || false,
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  })
  const workspace: GitWorkspace = { run, close: vi.fn(async () => {}) }
  const host = {
    access: vi.fn(async () => access),
    revoke: vi.fn(async () => {}),
  }
  const factory = {
    open: vi
      .fn<(access: RepositoryAccess[]) => Promise<GitWorkspace>>()
      .mockResolvedValue(workspace),
  }
  return {
    host,
    factory,
    workspace,
    run,
    validator: new SandboxIntegrationValidator(host, factory),
  }
}

describe("independent integration validation", () => {
  it("validates the exact durable commit with only candidate read access", async () => {
    const f = fixture()
    const evidence = await f.validator.validate(
      { repoId: "candidate", headCommit: commit },
      commands
    )
    expect(f.host.access).toHaveBeenCalledWith("candidate", "read")
    expect(f.factory.open.mock.calls[0]![0]).toMatchObject([
      { repoId: "candidate", scope: "read" },
    ])
    expect(f.run).toHaveBeenCalledWith(
      ["git", "checkout", "--detach", commit],
      "/workspace/repo"
    )
    expect(evidence.checks).toMatchObject([
      { name: "npm ci", status: "passed", required: true, exitCode: 0 },
      {
        name: "test",
        status: "passed",
        required: true,
        stdout: "independent output",
      },
    ])
    expect(f.host.revoke).toHaveBeenCalledOnce()
    expect(f.workspace.close).toHaveBeenCalledOnce()
  })

  it("records failed installation and skips project checks", async () => {
    const f = fixture({ installFails: true })
    const evidence = await f.validator.validate(
      { repoId: "candidate", headCommit: commit },
      commands
    )
    expect(evidence.checks).toMatchObject([
      { name: "npm ci", status: "failed" },
      { name: "test", status: "skipped" },
    ])
    expect(
      f.run.mock.calls.some(
        ([command]) => command[0] === "npm" && command[1] === "test"
      )
    ).toBe(false)
  })

  it("fails truncated checks and rejects validation that changes the candidate", async () => {
    const truncated = fixture({ testTruncated: true })
    expect(
      (
        await truncated.validator.validate(
          { repoId: "candidate", headCommit: commit },
          commands
        )
      ).checks[1]!.status
    ).toBe("failed")
    const dirty = fixture({ dirty: true })
    await expect(
      dirty.validator.validate(
        { repoId: "candidate", headCommit: commit },
        commands
      )
    ).rejects.toThrow("Validation changed")
    expect(dirty.host.revoke).toHaveBeenCalledOnce()
    expect(dirty.workspace.close).toHaveBeenCalledOnce()
  })
})
