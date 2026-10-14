import { describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:test"
import {
  scriptedStressAgent,
  stressFiles,
  stressManifest,
} from "@terminus/protocol"
import type { RepositoryAccess } from "@terminus/artifacts"
import { SandboxConductorSessions } from "./conductor-session"
import type { StationSandbox } from "./station-runner"

const model = "@cf/zai-org/glm-5.3"
const commit = "c".repeat(40)

function fixture(
  options: {
    installExit?: number
    testExit?: number
    changed?: string[]
    scripted?: boolean
  } = {}
) {
  const calls: {
    command: string[]
    cwd?: string
    env?: Record<string, string>
  }[] = []
  const order: string[] = []
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
    run: vi.fn(async (command: string[], cwd, environment) => {
      calls.push({ command, cwd, env: environment })
      const fingerprint = ["record", "compare"].includes(command[3] ?? "")
      order.push(
        fingerprint
          ? `fingerprint:${command[3]}`
          : command.slice(0, 2).join(" ")
      )
      const ok = { exitCode: 0, stdout: "", stderr: "" }
      if (command[1] === "--version") return { ...ok, stdout: "1.18.32" }
      if (command[0] === "git" && command[1] === "rev-parse")
        return { ...ok, stdout: `${commit}\n` }
      if (command[0] === "git" && command[1] === "ls-files")
        return { ...ok, stdout: ".env\0src/App.tsx\0" }
      if (command[0] === "npm" && command[1] === "test")
        return {
          ...ok,
          exitCode: options.testExit ?? 0,
          stdout: options.testExit ? "" : "1 test passed",
          stderr: options.testExit ? "Expected footer" : "",
        }
      if (command[0] === "npm")
        return {
          ...ok,
          exitCode: options.installExit ?? 0,
          stderr: options.installExit ? "npm ERR! ERESOLVE" : "",
        }
      if (command[3] === "compare") {
        const paths = options.changed ?? []
        return { ...ok, stdout: JSON.stringify({ count: paths.length, paths }) }
      }
      if (command[0] === "node" && command[1] === "-e")
        return { ...ok, stdout: "" }
      if (command[0] === "node")
        return {
          ...ok,
          stdout: [
            '{"sessionID":"ses_1"}',
            '{"type":"text","part":{"text":"{\\"verdict\\":\\"accept\\"}"}}',
            '{"type":"tool_counts","counts":{"bash":3}}',
          ].join("\n"),
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
  const sessions = new SandboxConductorSessions(
    {
      ...env,
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_ID: "gateway",
      AI_GATEWAY_TOKEN: "worker-only-secret",
    },
    repositories,
    () => sandbox,
    undefined,
    options.scripted
  )
  const open = () =>
    sessions.open({ model, candidate: { repoId: "n/station-a", commit } })
  const material = { "candidate.diff": "+x", "review.json": "{}" }
  return { sandbox, repositories, calls, order, open, material }
}

describe("Sandbox Conductor session", () => {
  it("verifies scripted fixture contents after independent validation and never grants model access", async () => {
    const f = fixture({ scripted: true })
    const session = f.open()
    const validation = ["typecheck", "test", "build"].map((name) => ({
      name,
      command: ["npm", "run", name],
    }))
    const preparation = await session.prepare(validation)
    const task = { runId: "00000000-0000-4000-8000-000000000004", train: 1 }
    const material = {
      "review.json": JSON.stringify({
        manifest: stressManifest(task),
        proposal: {
          headCommit: commit,
          changedPaths: Object.keys(stressFiles(task)),
          diff: "+checkpoint",
          evidence: preparation.evidence,
          agent: scriptedStressAgent,
          agentSummary: null,
        },
      }),
    }
    expect(
      JSON.parse(await session.start("unused", "unused", material)).verdict
    ).toBe("accept")
    expect(f.order).not.toContain("configure:model")
    expect(f.order.at(-1)).toBe("fingerprint:compare")
    expect(
      f.calls.some(
        ({ command }) =>
          command[0] === "node" &&
          command[1] === "-e" &&
          command[2]?.includes("Incorrect stress checkpoint")
      )
    ).toBe(true)
    await expect(
      session.start("unused", "unused", { "review.json": "{}" })
    ).rejects.toThrow()
    await session.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
  })

  it("installs with read access only, fingerprints and seals, then allows only the model", async () => {
    const f = fixture()
    const session = f.open()
    expect(await session.prepare()).toEqual({
      install: { exitCode: 0, outputTail: "" },
    })
    expect(f.sandbox.configure).toHaveBeenLastCalledWith({
      repositories: [],
      allowModel: false,
    })
    await session.start("S", "Review", f.material)
    expect(f.repositories.access).toHaveBeenCalledWith("n/station-a", "read")
    expect(f.sandbox.configure).toHaveBeenNthCalledWith(1, {
      repositories: [
        {
          remote: expect.stringContaining("n/station-a"),
          token: "token-n/station-a",
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
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    const commands = f.calls.map((c) => c.command)
    expect(commands).toContainEqual(["git", "checkout", "--detach", commit])
    expect(commands).toContainEqual(["rm", "-f", "--", ".env"])
    expect(f.sandbox.write).toHaveBeenCalledWith(
      "/workspace/review/candidate.diff",
      "+x"
    )
    // Dependencies install before the model is reachable; the fingerprint is
    // taken after install scripts ran and before history is removed.
    const at = (entry: string) => f.order.indexOf(entry)
    expect(at("npm ci")).toBeLessThan(at("fingerprint:record"))
    expect(at("fingerprint:record")).toBeLessThan(at("rm -rf"))
    expect(at("rm -rf")).toBeLessThan(at("configure:model"))
    expect(at("write:/workspace/review/review.json")).toBeLessThan(
      at("configure:model")
    )
  })

  it("refuses a failed installation in scripted review", async () => {
    const f = fixture({ scripted: true, installExit: 1 })
    const session = f.open()
    await expect(session.prepare()).rejects.toThrow(
      "Stress review dependency installation failed"
    )
    await session.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
  })

  it("reports a failed install instead of hiding it", async () => {
    const f = fixture({ installExit: 1 })
    expect(await f.open().prepare()).toEqual({
      install: { exitCode: 1, outputTail: "npm ERR! ERESOLVE" },
    })
  })

  it("runs requested validation in the sealed checkout without repository or model access", async () => {
    const f = fixture({ testExit: 1 })
    const preparation = await f
      .open()
      .prepare([{ name: "test", command: ["npm", "test"] }])
    expect(preparation.evidence).toEqual({
      checks: [
        {
          name: "test",
          command: ["npm", "test"],
          required: true,
          status: "failed",
          exitCode: 1,
          stdout: "",
          stderr: "Expected footer",
          outputTruncated: false,
        },
      ],
    })
    const check = f.calls.find((c) => c.command[1] === "test")!
    expect(check.cwd).toBe("/workspace/repo")
    // Checks run after access is dropped, and their changes are detected.
    const at = (entry: string) => f.order.lastIndexOf(entry)
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(at("rm -rf")).toBeLessThan(at("npm test"))
    expect(at("configure:git")).toBeLessThan(at("npm test"))
    expect(at("npm test")).toBeLessThan(at("fingerprint:compare"))
    expect(f.order).not.toContain("configure:model")
  })

  it("discards validation that changed tracked files", async () => {
    const f = fixture({ changed: ["src/App.tsx"] })
    await expect(
      f.open().prepare([{ name: "test", command: ["npm", "test"] }])
    ).rejects.toThrow(
      "Project validation changed 1 tracked file(s) in the candidate checkout (src/App.tsx)"
    )
  })

  it("runs the Conductor agent with commands allowed and checks the candidate is unchanged", async () => {
    const f = fixture()
    const session = f.open()
    await session.prepare()
    expect(await session.start("SYSTEM PROMPT", "Review it", f.material)).toBe(
      '{"verdict":"accept"}'
    )
    const config = JSON.parse(
      vi
        .mocked(f.sandbox.write)
        .mock.calls.find(([path]) => path === "/workspace/opencode.json")![1]
    )
    expect(config.agent.conductor.permission).toMatchObject({
      edit: "deny",
      bash: "allow",
    })
    const harness = f.calls.find((c) => c.command[0] === "bash")!
    expect(harness.command).toContain("conductor")
    expect(harness.cwd).toBe("/workspace/repo")
    expect(JSON.stringify(harness.env)).not.toContain("worker-only-secret")
    expect(f.order.at(-1)).toBe("fingerprint:compare")
    expect(await session.resume("Fix the JSON")).toBe('{"verdict":"accept"}')
    expect(f.calls.filter((c) => c.command[0] === "bash")[1]!.command).toEqual(
      expect.arrayContaining(["--session", "ses_1"])
    )
    expect(f.order.at(-1)).toBe("fingerprint:compare")
    await session.close()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })

  it("discards a review that changed tracked files", async () => {
    const f = fixture({ changed: ["src/App.tsx"] })
    const session = f.open()
    await session.prepare()
    await expect(session.start("S", "Review", f.material)).rejects.toThrow(
      "changed 1 tracked file(s) in the candidate checkout (src/App.tsx)"
    )
  })

  it("revokes access when preparation is interrupted", async () => {
    const f = fixture()
    vi.mocked(f.sandbox.run).mockRejectedValueOnce(new Error("lost"))
    const session = f.open()
    await expect(session.prepare()).rejects.toThrow("lost")
    await session.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })
})
