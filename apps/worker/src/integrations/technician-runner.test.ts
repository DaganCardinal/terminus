import { describe, expect, it, vi, afterEach } from "vitest"
import { env } from "cloudflare:test"
import { TechnicianGit, type RepositoryAccess } from "@terminus/artifacts"
import type { TechnicianRepair } from "@terminus/domain"
import { SandboxTechnicianRunner } from "./technician-runner"
import type { StationSandbox } from "./station-runner"
const model = "@cf/zai-org/glm-5.3-flash"
const base = "a".repeat(40),
  candidate = "b".repeat(40)
afterEach(() => vi.restoreAllMocks())
function fixture(exitCode = 0) {
  const repair: TechnicianRepair = {
    id: "repair",
    networkId: "network",
    conflictId: "conflict",
    source: {
      integrationId: "integration",
      trainId: "train",
      trainRepoId: "train-repo",
      trainCommit: base,
      trainBaseline: base,
      terminusRepoId: "terminus",
      terminusCommit: base,
      acceptedCommits: [base],
    },
    scope: ["src/shared.ts"],
    description: "Merge conflict",
    manifests: [],
    expectedChecks: ["test"],
    agent: { harness: "opencode@1.18.32", model },
    createdAt: "2026-10-04",
    state: { status: "running", workspaceRepoId: "repair-repo" },
  }
  const sandbox: StationSandbox = {
    // The real Sandbox restores a cache first; the install itself is the same.
    installDependencies: vi.fn(async (cwd: string) =>
      sandbox.run(["npm", "ci", "--no-audit", "--no-fund"], cwd)
    ),
    configure: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(async (command: string[]) =>
      command[1] === "--version"
        ? { exitCode: 0, stdout: "1.18.32", stderr: "" }
        : command[0] === "node" && command[1] === "-e"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : {
              exitCode: command[0] === "bash" ? exitCode : 0,
              stdout:
                '{"type":"text","part":{"text":"Tests passed according to the agent"}}',
              stderr: "",
            }
    ),
  }
  const repositories = {
    access: vi.fn(
      async (
        repoId: string,
        scope: "read" | "write"
      ): Promise<RepositoryAccess> => ({
        repoId,
        scope,
        remote: `https://account.artifacts.cloudflare.net/git/default/${repoId}.git`,
        branch: "main",
        token: `token-${repoId}`,
        tokenId: repoId,
      })
    ),
    revoke: vi.fn(async () => {}),
  }
  vi.spyOn(TechnicianGit.prototype, "prepare").mockResolvedValue(null)
  vi.spyOn(TechnicianGit.prototype, "candidateCommit").mockResolvedValue(
    candidate
  )
  const publish = vi
    .spyOn(TechnicianGit.prototype, "publish")
    .mockResolvedValue()
  vi.spyOn(TechnicianGit.prototype, "snapshot").mockResolvedValue({
    diff: "Actual full integration diff",
    changedPaths: repair.scope,
    repairDiff: "Actual repair diff",
    repairPaths: repair.scope,
  })
  const runner = new SandboxTechnicianRunner(
    {
      ...env,
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_TOKEN: "worker-only-secret",
    },
    model,
    repositories,
    () => sandbox
  )
  return { repair, runner, sandbox, repositories, publish }
}
describe("Sandbox Technician capabilities and completion", () => {
  it("runs the configured harness, persists actual work, and never treats its summary as evidence", async () => {
    const f = fixture()
    const result = await f.runner.run(f.repair, "repair-repo")
    expect(f.repositories.access.mock.calls).toEqual([
      ["repair-repo", "write"],
      ["train-repo", "read"],
    ])
    expect(f.sandbox.configure).toHaveBeenCalledWith(
      expect.objectContaining({ allowModel: true, model })
    )
    expect(f.sandbox.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "opencode",
        "--auto",
        "--agent",
        "technician",
        "--model",
        `terminus/${model}`,
      ]),
      "/workspace/repo",
      expect.objectContaining({
        OPENCODE_CONFIG: "/workspace/opencode.json",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
      }),
      undefined
    )
    const config = JSON.parse(
      vi
        .mocked(f.sandbox.write)
        .mock.calls.find(([path]) => path === "/workspace/opencode.json")![1]
    )
    expect(config.agent.technician.prompt).toContain(
      "Edit only the listed conflicted files"
    )
    expect(JSON.stringify(vi.mocked(f.sandbox.write).mock.calls)).not.toContain(
      "worker-only-secret"
    )
    expect(result.proposal).toMatchObject({
      headCommit: candidate,
      diff: "Actual full integration diff",
      evidence: { checks: [] },
      agentSummary: "Tests passed according to the agent",
    })
    expect(f.publish).toHaveBeenCalledWith(candidate)
    expect(f.repositories.revoke).toHaveBeenCalledTimes(2)
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
  })
  it("does not publish an unsuccessful harness run and revokes all grants", async () => {
    const f = fixture(1)
    await expect(f.runner.run(f.repair, "repair-repo")).rejects.toThrow(
      "OpenCode exited"
    )
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.repositories.revoke).toHaveBeenCalledTimes(2)
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
  })
  it("recovers a published candidate without another model call", async () => {
    const f = fixture()
    vi.mocked(TechnicianGit.prototype.prepare).mockResolvedValue(candidate)
    expect(
      (await f.runner.run(f.repair, "repair-repo")).proposal.headCommit
    ).toBe(candidate)
    expect(f.sandbox.run).not.toHaveBeenCalled()
    expect(f.repositories.revoke).toHaveBeenCalledTimes(2)
  })
  it("revokes partial grants when acquiring read access fails", async () => {
    const f = fixture()
    f.repositories.access.mockRejectedValueOnce(new Error("No repair access"))
    await expect(f.runner.run(f.repair, "repair-repo")).rejects.toThrow(
      "No repair access"
    )
    expect(f.sandbox.configure).not.toHaveBeenCalled()
    const second = fixture()
    second.repositories.access
      .mockResolvedValueOnce({
        repoId: "repair-repo",
        scope: "write",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/repair.git",
        branch: "main",
        token: "repair-token",
        tokenId: "repair-token",
      })
      .mockRejectedValueOnce(new Error("No Train access"))
    await expect(
      second.runner.run(second.repair, "repair-repo")
    ).rejects.toThrow("No Train access")
    expect(second.repositories.revoke).toHaveBeenCalledTimes(1)
    expect(second.sandbox.configure).not.toHaveBeenCalled()
  })
})
