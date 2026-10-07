import { describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:test"
import type { RepositoryAccess } from "@terminus/artifacts"
import { SandboxConductorSessions } from "./conductor-session"
import type { StationSandbox } from "./station-runner"

const model = "@cf/zai-org/glm-5.3"
const commit = "c".repeat(40)

function fixture(options: { installExit?: number; changed?: string[] } = {}) {
  const calls: {
    command: string[]
    cwd?: string
    env?: Record<string, string>
  }[] = []
  const order: string[] = []
  const sandbox: StationSandbox = {
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
    () => sandbox
  )
  const open = () =>
    sessions.open({ model, candidate: { repoId: "n/station-a", commit } })
  const material = { "candidate.diff": "+x", "review.json": "{}" }
  return { sandbox, repositories, calls, order, open, material }
}

describe("Sandbox Conductor session", () => {
  it("installs with read access only, fingerprints and seals, then allows only the model", async () => {
    const f = fixture()
    const session = f.open()
    expect(await session.prepare(f.material)).toEqual({
      install: { exitCode: 0, outputTail: "" },
    })
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

  it("reports a failed install instead of hiding it", async () => {
    const f = fixture({ installExit: 1 })
    expect(await f.open().prepare(f.material)).toEqual({
      install: { exitCode: 1, outputTail: "npm ERR! ERESOLVE" },
    })
  })

  it("runs the Conductor agent with commands allowed and checks the candidate is unchanged", async () => {
    const f = fixture()
    const session = f.open()
    await session.prepare(f.material)
    expect(await session.start("SYSTEM PROMPT", "Review it")).toBe(
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
    await session.prepare(f.material)
    await expect(session.start("S", "Review")).rejects.toThrow(
      "changed 1 tracked file(s) in the candidate checkout (src/App.tsx)"
    )
  })

  it("revokes access when preparation is interrupted", async () => {
    const f = fixture()
    vi.mocked(f.sandbox.run).mockRejectedValueOnce(new Error("lost"))
    const session = f.open()
    await expect(session.prepare(f.material)).rejects.toThrow("lost")
    await session.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })
})
