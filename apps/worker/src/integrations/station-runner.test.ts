import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StationRunInput } from "@terminus/agent-runtime"
import {
  scriptedStressAgent,
  stressFiles,
  stressManifest,
} from "@terminus/protocol"
import type { RepositoryAccess } from "@terminus/artifacts"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { SandboxStationRunner, type StationSandbox } from "./station-runner"

const model = "@cf/zai-org/glm-5.3-flash"
const base = "a".repeat(40)
const candidate = "b".repeat(40)

afterEach(() => vi.restoreAllMocks())

/** `failedTests` also makes the runner validate, as with a fake Conductor. */
async function fixture(
  failedTests = false,
  inheritedMethods = false,
  scripted = false
) {
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
    // The real Sandbox restores a cache first; the install itself is the same.
    installDependencies: vi.fn(async (cwd: string) =>
      sandbox.run(["npm", "ci", "--no-audit", "--no-fund"], cwd)
    ),
    configure: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(async (command: string[]) => {
      let stdout = ""
      let exitCode = 0
      if (command[1] === "--version") stdout = "1.18.32"
      if (
        command[0] === "node" &&
        command[1] === "/workspace/harness-events.mjs"
      )
        stdout =
          '{"type":"text","part":{"text":"All tests passed according to the agent"}}'
      if (command[0] === "npm" && command[1] === "test" && failedTests)
        exitCode = 1
      if (command[0] === "git") {
        if (command[1] === "rev-parse") stdout = candidate
        if (command[1] === "ls-remote")
          stdout = `${candidate}\trefs/heads/main\n`
        // The candidate changes no secret files, so the raw secret listing is empty.
        if (command.includes("-z") && !command.includes("--raw"))
          stdout = "src/footer.tsx\0"
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
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_ID: "test",
      AI_GATEWAY_TOKEN: "test-worker-token",
    },
    model,
    repositories,
    ports.store,
    () =>
      inheritedMethods ? (Object.create(sandbox) as StationSandbox) : sandbox,
    undefined,
    failedTests,
    scripted
  )
  return { runner, input, sandbox, repositories, store: ports.store }
}

describe("Station execution boundary", () => {
  it("keeps real checkpoint/push mechanics for scripted edits without model access", async () => {
    const f = await fixture(false, false, true)
    const task = { runId: "00000000-0000-4000-8000-000000000003", train: 1 }
    f.input.manifest = stressManifest(task)
    const result = await f.runner.run(f.input)
    expect(result.ok && result.proposal.agent).toEqual(scriptedStressAgent)
    expect(result.ok && result.proposal.evidence).toEqual({ checks: [] })
    expect(f.sandbox.configure).toHaveBeenCalledWith({
      repositories: [expect.objectContaining({ scope: "write" })],
      allowModel: false,
    })
    expect(f.sandbox.run).toHaveBeenCalledWith(
      ["node", "-e", expect.any(String), JSON.stringify(stressFiles(task))],
      "/workspace/repo",
      undefined
    )
    expect(f.sandbox.write).not.toHaveBeenCalledWith(
      "/workspace/opencode.json",
      expect.anything()
    )
    expect(f.sandbox.run).toHaveBeenCalledWith(
      expect.arrayContaining(["git", "push"]),
      "/workspace/repo",
      undefined
    )
    const calls = vi.mocked(f.sandbox.run).mock.calls.length
    expect(await f.runner.run(f.input)).toEqual(result)
    expect(vi.mocked(f.sandbox.run).mock.calls.length).toBe(calls)
    expect(await f.store.agentRun(f.input, scriptedStressAgent)).toEqual(result)
  })
  it("refuses ordinary manifests in the scripted profile before granting credentials", async () => {
    const f = await fixture(false, false, true)
    await expect(f.runner.run(f.input)).rejects.toThrow("fixture manifests")
    expect(f.repositories.access).not.toHaveBeenCalled()
  })

  it("runs the harness with inherited Sandbox methods, as exposed by an RPC stub", async () => {
    const f = await fixture(false, true)
    const result = await f.runner.run(f.input)
    expect(result.ok).toBe(true)
    expect(f.sandbox.write).toHaveBeenCalledWith(
      "/workspace/harness-events.mjs",
      expect.any(String)
    )
    expect(f.sandbox.run).toHaveBeenCalledWith(
      expect.arrayContaining(["bash", "opencode"]),
      "/workspace/repo",
      expect.any(Object)
    )
    expect(await f.store.agentRun(f.input, model)).toEqual(result)
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
  })
  it("identifies the failed phase without logging agent arguments or credentials", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failed = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = await fixture()
    const error = new Error(
      "internal error; reference = abc123 test-worker-token"
    )
    const run = vi.mocked(f.sandbox.run).getMockImplementation()!
    vi.mocked(f.sandbox.run).mockImplementation(async (...args) => {
      if (args[0][0] === "bash" && args[0].includes("opencode")) throw error
      return run(...args)
    })
    await expect(f.runner.run(f.input)).rejects.toMatchObject({
      message: `Station run failed during harness: ${error.message}`,
      cause: error,
    })
    expect(failed).toHaveBeenCalledWith(
      "Station command failed",
      expect.objectContaining({
        runId: f.input.runId,
        phase: "harness",
        command: "bash",
        reference: "abc123",
      })
    )
    const logs = JSON.stringify([info.mock.calls, failed.mock.calls])
    for (const secret of [
      "test-worker-token",
      "test-station-token",
      f.input.manifest.goal,
    ])
      expect(logs).not.toContain(secret)
    expect(f.repositories.revoke).toHaveBeenCalledTimes(1)
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
  })
  it("releases a Sandbox when configuration fails before any candidate exists", async () => {
    const f = await fixture()
    vi.mocked(f.sandbox.configure).mockRejectedValueOnce(
      new Error("Container setup failed")
    )
    await expect(f.runner.run(f.input)).rejects.toThrow(
      "Station run failed during checkout: Container setup failed"
    )
    expect(f.sandbox.close).toHaveBeenCalledTimes(1)
    expect(f.repositories.revoke).toHaveBeenCalledTimes(1)
    expect(f.sandbox.run).not.toHaveBeenCalled()
  })
  it("preserves the original failure and revokes access when cleanup also fails", async () => {
    const f = await fixture()
    vi.mocked(f.sandbox.write).mockRejectedValueOnce(new Error("Write failed"))
    vi.mocked(f.sandbox.close).mockRejectedValueOnce(
      new Error("Cleanup failed")
    )
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(f.runner.run(f.input)).rejects.toThrow("Write failed")
    expect(f.repositories.revoke).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("Station Sandbox cleanup failed", {
      runId: f.input.runId,
      stationId: f.input.stationId,
    })
  })
  it("retains candidate Git objects when recording evidence has an uncertain outcome", async () => {
    const f = await fixture()
    vi.spyOn(f.store, "recordAgentRun").mockRejectedValueOnce(
      new Error("Evidence acknowledgement lost")
    )
    await expect(f.runner.run(f.input)).rejects.toThrow(
      "Evidence acknowledgement lost"
    )
    expect(f.sandbox.close).not.toHaveBeenCalled()
    expect(f.repositories.revoke).toHaveBeenCalledTimes(1)
  })
  it("leaves validation to the Conductor's clean checkout by default", async () => {
    const f = await fixture()
    const result = await f.runner.run(f.input)
    if (!result.ok) throw new Error("Expected a proposal")
    expect(result.proposal.evidence).toEqual({ checks: [] })
    expect(
      vi
        .mocked(f.sandbox.run)
        .mock.calls.some(([command]) => command.join(" ") === "npm test")
    ).toBe(false)
  })
  it("collects validation when asked, persists evidence before stopping, and reuses a durable result", async () => {
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
      run.mock.calls.filter(
        ([command]) => command[0] === "bash" && command.includes("opencode")
      )
    ).toHaveLength(1)
  })
  it("configures the Station agent only after repository install scripts have run", async () => {
    const f = await fixture()
    await f.runner.run(f.input)
    const run = vi.mocked(f.sandbox.run).mock
    const write = vi.mocked(f.sandbox.write).mock
    const order = (command: string) =>
      run.invocationCallOrder[
        run.calls.findIndex(([args]) => args.slice(0, 2).join(" ") === command)
      ]!
    const configured =
      write.invocationCallOrder[
        write.calls.findIndex(([path]) => path === "/workspace/opencode.json")
      ]!
    expect(order("npm ci")).toBeLessThan(configured)
    expect(order("node -e")).toBeLessThan(configured)
    expect(configured).toBeLessThan(order("bash -c"))
    const config = JSON.parse(
      write.calls.find(([path]) => path === "/workspace/opencode.json")![1]
    )
    expect(config.agent.station.prompt).toContain("Terminus Station Agent")
    const [harness, cwd, environment] = run.calls.find(
      ([args]) => args[0] === "bash" && args.includes("opencode")
    )!
    expect(harness).toEqual(expect.arrayContaining(["--agent", "station"]))
    expect(cwd).toBe("/workspace/repo")
    expect(environment).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    })
    const message = harness.at(-1)!
    expect(message).toContain("Manifest: ")
    expect(message).toContain(
      "The checkout has no root AGENTS.md or CLAUDE.md."
    )
    expect(message).not.toContain("Terminus Station Agent")
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
        .mock.calls.filter(
          ([command]) => command[0] === "bash" && command.includes("opencode")
        )
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
