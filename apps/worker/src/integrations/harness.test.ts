import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import {
  executionConfig,
  dispatcherHarnessAgent,
  conductorHarnessAgent,
} from "@terminus/agent-runtime"
import { HARNESS_CATALOG, type Harness } from "@terminus/protocol"
import { HarnessSession, prepareHarness } from "./harness"
import type { StationSandbox } from "./station-runner"

const models: Record<Harness, string> = {
  opencode: "@cf/zai-org/glm-5.3-flash",
  "claude-code": "anthropic/claude-haiku-4-5-20251001",
  codex: "openai/gpt-6-luna",
}

describe("shared Sandbox harness session", () => {
  it.each(
    HARNESS_CATALOG.flatMap((harness) =>
      [dispatcherHarnessAgent("Plan"), conductorHarnessAgent("Review")].map(
        (agent) => ({ ...harness, agent })
      )
    )
  )(
    "continues $id / $agent.name without resetting its native state",
    async ({ id, version, agent }) => {
      const calls: string[][] = []
      let runs = 0
      const sandbox: StationSandbox = {
        // The real Sandbox restores a cache first; the install itself is the same.
        installDependencies: vi.fn(async (cwd: string) =>
          sandbox.run(["npm", "ci", "--no-audit", "--no-fund"], cwd)
        ),
        write: vi.fn(async () => {}),
        configure: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        run: vi.fn(async (command) => {
          calls.push(command)
          const ok = { stdout: "", stderr: "", exitCode: 0 }
          if (command[1] === "--version") return { ...ok, stdout: version }
          if (command[0] === "node" && command[1] !== "-e") {
            runs++
            const answer = `answer ${runs}`
            const events =
              id === "opencode"
                ? [
                    { sessionID: "session-1" },
                    { type: "text", part: { text: answer } },
                  ]
                : id === "claude-code"
                  ? [
                      {
                        type: "result",
                        subtype: "success",
                        is_error: false,
                        result: answer,
                        session_id: "session-1",
                      },
                    ]
                  : [
                      { type: "thread.started", thread_id: "session-1" },
                      {
                        type: "item.completed",
                        item: { type: "agent_message", text: answer },
                      },
                      { type: "turn.completed" },
                    ]
            return {
              ...ok,
              stdout: events.map((event) => JSON.stringify(event)).join("\n"),
            }
          }
          return ok
        }),
      }
      const session = new HarnessSession(
        {
          ...env,
          ALTERNATIVE_HARNESSES_ENABLED: "true",
          AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
          AI_GATEWAY_ID: "gateway",
          AI_GATEWAY_TOKEN: "worker-only-secret",
        },
        sandbox,
        {
          role: agent.name,
          model: models[id],
          execution: executionConfig(models[id], id),
          directory: "/workspace/repo",
          startTimeoutMs: 1000,
          resumeTimeoutMs: 1000,
        }
      )
      expect(await session.start(agent, "assignment")).toBe("answer 1")
      const initialFiles = vi
        .mocked(sandbox.write)
        .mock.calls.filter(
          ([path]) => !path.endsWith("harness-events.mjs")
        ).length
      expect(await session.resume("correction")).toBe("answer 2")
      expect(
        calls.filter((command) => command[0] === "node" && command[1] === "-e")
      ).toHaveLength(1)
      expect(
        calls.filter((command) => command[1] === "--version")
      ).toHaveLength(1)
      expect(
        vi
          .mocked(sandbox.write)
          .mock.calls.filter(([path]) => !path.endsWith("harness-events.mjs"))
      ).toHaveLength(initialFiles)
      const commands = calls.filter((command) => command[0] === "bash")
      expect(commands).toHaveLength(2)
      expect(commands[1]).toContain("session-1")
      expect(commands[1]!.at(-1)).toBe("correction")
      expect(JSON.stringify(vi.mocked(sandbox.run).mock.calls)).not.toContain(
        "worker-only-secret"
      )
      expect(JSON.stringify(vi.mocked(sandbox.write).mock.calls)).not.toContain(
        "worker-only-secret"
      )
    }
  )
})

describe("OpenCode external-provider gate", () => {
  const prepare = (gate: string) => {
    const write = vi.fn(async () => {})
    const run = vi.fn(async (command: string[]) => ({
      stdout: command[1] === "--version" ? HARNESS_CATALOG[0].version : "",
      stderr: "",
      exitCode: 0,
    }))
    const model = "anthropic/claude-haiku-4-5-20251001"
    return {
      run,
      prepared: prepareHarness(
        {
          ...env,
          ALTERNATIVE_HARNESSES_ENABLED: "true",
          OPENCODE_EXTERNAL_PROVIDERS_ENABLED: gate,
          AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
          AI_GATEWAY_ID: "gateway",
          AI_GATEWAY_TOKEN: "worker-only-secret",
        },
        { write },
        { run },
        {
          model,
          execution: executionConfig(model, "opencode"),
          agent: conductorHarnessAgent("Review"),
          directory: "/workspace/repo",
          assignment: "assignment",
        }
      ),
    }
  }

  it("refuses Anthropic or OpenAI under OpenCode before touching the Sandbox", async () => {
    const { run, prepared } = prepare("false")
    await expect(prepared).rejects.toThrow(/disabled/)
    expect(run).not.toHaveBeenCalled()
  })

  it("prepares them once the gate is on", async () => {
    expect((await prepare("true").prepared).harness).toBe("opencode")
  })
})
