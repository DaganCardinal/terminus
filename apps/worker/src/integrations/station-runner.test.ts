import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { StationRunInput } from "@terminus/agent-runtime"
import type { RepositoryAccess } from "@terminus/artifacts"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { SandboxStationRunner, type StationSandbox } from "./station-runner"

const model = "@cf/zai-org/glm-5.3-flash"
const base = "a".repeat(40)
const candidate = "b".repeat(40)

async function fixture(failedTests = false) {
  const ports = testPorts()
  const network = await seedNetwork(ports)
  const { stations } = await seedLine(ports, network.id)
  const access: RepositoryAccess = {
    repoId: "station-repo",
    remote: "https://account.artifacts.cloudflare.net/git/default/station.git",
    branch: "main",
    token: "test-station-token",
    tokenId: "token-id",
    scope: "write",
  }
  const sandbox: StationSandbox = {
    configure: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(async (command: string[]) => {
      let stdout = ""
      let exitCode = 0
      if (command[0] === "opencode")
        stdout =
          '{"type":"text","part":{"text":"All tests passed according to the agent"}}'
      if (command[0] === "npm" && command[1] === "test" && failedTests)
        exitCode = 1
      if (command[0] === "git") {
        if (command[1] === "rev-parse") stdout = candidate
        if (command[1] === "ls-remote")
          stdout = `${candidate}\trefs/heads/main\n`
        if (command.includes("-z")) stdout = "src/footer.tsx\0"
        if (command.includes("--binary"))
          stdout = "+export function Footer() {}"
      }
      return {
        exitCode,
        stdout,
        stderr: exitCode ? "Independent test failure" : "",
      }
    }),
  }
  const repositories = {
    access: vi.fn(async () => access),
    revoke: vi.fn(async () => {}),
  }
  const input: StationRunInput = {
    stationId: stations[0]!.id,
    runId: `${stations[0]!.id}-s1-r0`,
    manifest: stations[0]!.manifest,
    workspace: { repoId: access.repoId, baseCommit: base },
    feedback: null,
    validation: network.validation,
  }
  const runner = new SandboxStationRunner(
    {
      ...env,
      STATION_AGENT_MODEL: model,
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_ID: "test",
      AI_GATEWAY_TOKEN: "test-worker-token",
    },
    repositories,
    ports.store,
    () => sandbox
  )
  return { runner, input, sandbox, repositories, store: ports.store }
}

describe("Station execution boundary", () => {
  it("collects independent validation, persists evidence before stopping, and reuses a durable result", async () => {
    const f = await fixture(true)
    const result = await f.runner.run(f.input)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected a proposal")
    expect(
      result.proposal.evidence.checks.find((check) => check.name === "test")
    ).toMatchObject({
      required: true,
      status: "failed",
      exitCode: 1,
      stderr: "Independent test failure",
    })
    expect(result.proposal.agentSummary).toContain("All tests passed")
    expect(result.proposal.diff).toContain("Footer")
    expect(await f.store.agentRun(f.input, model)).toEqual(result)
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
    expect(f.repositories.access).toHaveBeenCalledWith("station-repo", "write")
    expect(f.repositories.revoke).toHaveBeenCalledTimes(1)
    expect(await f.runner.run(f.input)).toEqual(result)
    expect(f.repositories.access).toHaveBeenCalledTimes(1)
    const run = vi.mocked(f.sandbox.run)
    expect(
      run.mock.calls.filter(([command]) => command[0] === "opencode")
    ).toHaveLength(1)
  })
  it("recovers a pushed candidate when publication acknowledgement fails without another model run", async () => {
    const f = await fixture()
    vi.spyOn(f.store, "publishAgentRun").mockRejectedValueOnce(
      new Error("D1 temporarily unavailable")
    )
    await expect(f.runner.run(f.input)).rejects.toThrow(
      "D1 temporarily unavailable"
    )
    expect(await f.store.agentRun(f.input, model)).toBeNull()
    expect(f.sandbox.close).not.toHaveBeenCalled()
    const result = await f.runner.run(f.input)
    expect(result.ok).toBe(true)
    expect(await f.store.agentRun(f.input, model)).toEqual(result)
    expect(
      vi
        .mocked(f.sandbox.run)
        .mock.calls.filter(([command]) => command[0] === "opencode")
    ).toHaveLength(1)
    expect(f.repositories.revoke).toHaveBeenCalledTimes(2)
  })

  it("does not call an agent for evidence names without a configured validation command", async () => {
    const f = await fixture()
    await expect(
      f.runner.run({
        ...f.input,
        manifest: { ...f.input.manifest, expectedEvidence: ["unknown-check"] },
      })
    ).rejects.toThrow("no validation command")
    expect(f.sandbox.run).not.toHaveBeenCalled()
    expect(f.repositories.access).not.toHaveBeenCalled()
  })
  it("rejects reusing a run identity with a changed manifest or model", async () => {
    const f = await fixture()
    await f.runner.run(f.input)
    await expect(
      f.store.agentRun(
        {
          ...f.input,
          manifest: { ...f.input.manifest, goal: "A different goal" },
        },
        model
      )
    ).rejects.toThrow("different input")
    await expect(f.store.agentRun(f.input, "different-model")).rejects.toThrow(
      "different input"
    )
  })
})
