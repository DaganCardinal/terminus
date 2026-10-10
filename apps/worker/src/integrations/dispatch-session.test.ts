import { describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:test"
import type { RepositoryAccess } from "@terminus/artifacts"
import { SandboxDispatchSessions } from "./dispatch-session"
import type { StationSandbox } from "./station-runner"

const model = "@cf/zai-org/glm-5.3"
const commit = "a".repeat(40)

function fixture(options: { testExit?: number; harnessExit?: number } = {}) {
  const calls: { command: string[]; env?: Record<string, string> }[] = []
  const order: string[] = []
  let harnessRuns = 0
  const sandbox: StationSandbox = {
    // The real Sandbox restores a cache first; the install itself is the same.
    installDependencies: vi.fn(async (cwd: string) =>
      sandbox.run(["npm", "ci", "--no-audit", "--no-fund"], cwd)
    ),
    configure: vi.fn(async (network) => {
      order.push(`configure:${network.allowModel ? "model" : "git"}`)
    }),
    write: vi.fn(async (path: string) => {
      order.push(`write:${path}`)
    }),
    close: vi.fn(async () => {
      order.push("close")
    }),
    run: vi.fn(async (command: string[], _cwd, environment) => {
      calls.push({ command, env: environment })
      order.push(command.slice(0, 2).join(" "))
      const ok = { exitCode: 0, stdout: "", stderr: "" }
      if (command[1] === "--version") return { ...ok, stdout: "1.18.32" }
      if (command[0] === "git" && command[1] === "rev-parse")
        return { ...ok, stdout: `${commit}\n` }
      if (command[0] === "git" && command[1] === "ls-files")
        return { ...ok, stdout: ".env\0src/App.tsx\0config/key.pem\0" }
      if (command[0] === "npm" && command[1] === "test")
        return {
          exitCode: options.testExit ?? 0,
          stdout: "x".repeat(3000) + "1 failing",
          stderr: "",
        }
      if (command[0] === "bash")
        return { ...ok, exitCode: options.harnessExit ?? 0 }
      if (command[0] === "node" && command[1] === "-e")
        return {
          ...ok,
          stdout: JSON.stringify({
            path: "AGENTS.md",
            content: "Always add a changelog entry",
            truncated: false,
          }),
        }
      if (command[0] === "node") {
        harnessRuns++
        return {
          ...ok,
          stdout: [
            '{"sessionID":"ses_1"}',
            `{"type":"text","part":{"text":"answer ${harnessRuns}"}}`,
            '{"type":"tool_counts","counts":{"task:explore":2}}',
          ].join("\n"),
        }
      }
      return ok
    }),
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
  const sessions = new SandboxDispatchSessions(
    {
      ...env,
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_ID: "gateway",
      AI_GATEWAY_TOKEN: "worker-only-secret",
    },
    repositories,
    () => sandbox
  )
  const open = (checkBaseline = false) =>
    sessions.open({
      model,
      repository: { repoId: "n/terminus", commit },
      checkBaseline,
      validation: [{ name: "test", command: ["npm", "test"] }],
    })
  return { sandbox, repositories, calls, order, open }
}

describe("Sandbox Dispatcher session", () => {
  it("checks out read-only, seals secrets and history, then allows only the model", async () => {
    const f = fixture()
    const session = f.open()
    expect(await session.prepare()).toBeNull()
    expect(f.sandbox.configure).toHaveBeenNthCalledWith(1, {
      repositories: [
        {
          remote: expect.stringContaining("n/terminus"),
          token: "token-n/terminus",
          scope: "read",
        },
      ],
      allowModel: false,
    })
    expect(f.sandbox.configure).toHaveBeenLastCalledWith({
      repositories: [],
      allowModel: true,
      model,
    })
    expect(f.repositories.access).toHaveBeenCalledWith("n/terminus", "read")
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.calls.map((c) => c.command)).toContainEqual([
      "rm",
      "-f",
      "--",
      ".env",
      "config/key.pem",
    ])
    expect(f.calls.map((c) => c.command)).toContainEqual([
      "rm",
      "-rf",
      "--",
      ".git",
    ])
    expect(f.calls.some((c) => c.command[0] === "npm")).toBe(false)
    expect(f.order.indexOf("rm -rf")).toBeLessThan(
      f.order.lastIndexOf("configure:model")
    )
  })

  it("runs trusted checks before sealing and reports trimmed results", async () => {
    const f = fixture({ testExit: 1 })
    const baseline = await f.open(true).prepare()
    expect(baseline).toMatchObject({
      commit,
      checks: [
        { name: "npm ci", status: "passed" },
        { name: "test", status: "failed", exitCode: 1 },
      ],
    })
    const tail = baseline!.checks[1]!.outputTail
    expect(tail).toHaveLength(2000)
    expect(tail.endsWith("1 failing")).toBe(true)
    expect(f.order.indexOf("npm test")).toBeLessThan(f.order.indexOf("rm -rf"))
    expect(f.order.indexOf("npm test")).toBeLessThan(
      f.order.indexOf("configure:model")
    )
  })

  it("starts the read-only Dispatcher agent and resumes the recorded session", async () => {
    const f = fixture()
    const session = f.open()
    await session.prepare()
    expect(await session.start("SYSTEM PROMPT", "Plan it")).toBe("answer 1")
    const config = JSON.parse(
      vi
        .mocked(f.sandbox.write)
        .mock.calls.find(([path]) => path === "/workspace/opencode.json")![1]
    )
    expect(config.agent.dispatcher.prompt).toMatch(
      /^SYSTEM PROMPT\n\n## Repository Content\n/
    )
    expect(config.agent.dispatcher.permission.edit).toBe("deny")
    const harness = f.calls.find((c) => c.command[0] === "bash")!
    expect(harness.command.slice(0, 4)).toEqual([
      "bash",
      "-c",
      'exec "$@" > "$0"',
      "/workspace/harness-session-1.jsonl",
    ])
    expect(harness.command).toContain("dispatcher")
    // Root guidance is read from the sealed checkout and supplied as data.
    expect(f.order.indexOf("rm -rf")).toBeLessThan(f.order.indexOf("node -e"))
    expect(f.order.indexOf("node -e")).toBeLessThan(f.order.indexOf("bash -c"))
    const message = harness.command.at(-1)!
    expect(message.startsWith("Plan it\n\n")).toBe(true)
    expect(message).toMatch(
      /<repository-guidance boundary="([\w-]+)">\nAlways add a changelog entry\n<\/repository-guidance boundary="\1">$/
    )
    expect(harness.env).toMatchObject({
      OPENCODE_CONFIG: "/workspace/opencode.json",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    })
    expect(JSON.stringify(harness.env)).not.toContain("worker-only-secret")
    expect(await session.resume("Fix it")).toBe("answer 2")
    const resumed = f.calls.filter((c) => c.command[0] === "bash")[1]!
    expect(resumed.command).toEqual(
      expect.arrayContaining(["--session", "ses_1"])
    )
    await session.close()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })

  it("fails on a harness error and revokes access when preparation is interrupted", async () => {
    const failing = fixture({ harnessExit: 1 })
    const session = failing.open()
    await session.prepare()
    await expect(session.start("S", "Plan")).rejects.toThrow("exited with 1")
    const f = fixture()
    vi.mocked(f.sandbox.run).mockRejectedValueOnce(new Error("lost"))
    const interrupted = f.open()
    await expect(interrupted.prepare()).rejects.toThrow("lost")
    await interrupted.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })
})
