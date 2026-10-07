import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  harnessInvocation,
  executionConfig,
  harnessResult,
  nativeHarnessEventFilterScript,
  installedHarnessVersion,
} from "./harness-adapters"
import {
  dispatcherHarnessAgent,
  conductorHarnessAgent,
  stationHarnessAgent,
  type HarnessAgent,
} from "./opencode"
import type { Harness } from "@terminus/protocol"

const harnesses: { harness: Harness; model: string }[] = [
  { harness: "opencode", model: "@cf/zai-org/glm-5.3-flash" },
  { harness: "claude-code", model: "anthropic/claude-haiku-4-5-20251001" },
  { harness: "codex", model: "openai/gpt-6-luna" },
]
const roles: HarnessAgent[] = [
  dispatcherHarnessAgent("Plan"),
  conductorHarnessAgent("Review"),
  stationHarnessAgent,
  {
    name: "technician",
    system: "Repair",
    description: "Scoped repair",
    capability: "repair",
  },
]
const gateway = { accountId: "account", gatewayId: "gateway" }

describe("role harness adapters", () => {
  it.each([
    ["opencode", "1.18.32"],
    ["claude-code", "2.1.280 (Claude Code)"],
    ["codex", "codex-cli 0.156.1"],
  ] as const)(
    "verifies the installed %s binary before recording provenance",
    (harness, stdout) => {
      expect(
        installedHarnessVersion(harness, { stdout, stderr: "", exitCode: 0 })
      ).toMatch(/^\d+\.\d+\.\d+$/)
      for (const output of [
        { stdout: "99.0.0", stderr: "", exitCode: 0 },
        { stdout, stderr: "", exitCode: 1 },
        { stdout, stderr: "", exitCode: 0, outputTruncated: true },
      ])
        expect(() => installedHarnessVersion(harness, output)).toThrow(
          "version"
        )
    }
  )
  it.each(
    harnesses.flatMap((item) => roles.map((role) => ({ ...item, role })))
  )(
    "prepares and resumes $harness / $role.name",
    ({ harness, model, role }) => {
      const config = executionConfig(model, harness)
      const initial = harnessInvocation(
        config,
        role,
        gateway,
        "/workspace/repo",
        "assignment"
      )
      const resumed = harnessInvocation(
        config,
        role,
        gateway,
        "/workspace/repo",
        "correction",
        "session-1"
      )
      expect(initial.command.at(-1)).toBe("assignment")
      expect(resumed.command).toContain("session-1")
      expect(resumed.command.at(-1)).toBe("correction")
      const configuredSystem =
        harness === "opencode"
          ? JSON.parse(Object.values(initial.files)[0]!).agent[role.name].prompt
          : initial.files["/workspace/harness-state/system.txt"]
      expect(configuredSystem).toContain(role.system)
      expect(JSON.stringify(initial)).not.toContain("--ephemeral")
      expect(JSON.stringify(initial)).not.toContain("--no-session-persistence")
      expect(JSON.stringify(initial)).not.toContain("--dangerously-bypass")
      if (harness === "claude-code") {
        expect(initial.command).toContain("--bare")
        const tools = initial.command[initial.command.indexOf("--tools") + 1]!
        if (role.capability === "planning")
          expect(tools).not.toMatch(/Bash|Edit|Write/)
        if (role.capability === "review")
          expect(tools).toBe("Read,Glob,Grep,Bash")
        expect(initial.env.ANTHROPIC_API_KEY).toBe("provided-by-worker")
        const settings = JSON.parse(
          initial.files["/workspace/harness-state/claude-settings.json"]!
        )
        expect(settings.disableAllHooks).toBe(true)
        expect(settings.sandbox.allowUnsandboxedCommands).toBe(false)
        expect(settings.sandbox.failIfUnavailable).toBe(true)
        if (role.capability === "review")
          expect(settings.sandbox.filesystem.denyWrite).toContain(
            "/workspace/repo"
          )
      }
      if (harness === "codex") {
        expect(initial.command).toContain('approval_policy="never"')
        expect(initial.command).toContain('default_permissions="terminus"')
        expect(initial.command).not.toContain("sandbox_mode")
        const filesystem = initial.command.find((value) =>
          value.startsWith("permissions.terminus.filesystem=")
        )!
        expect(filesystem).toContain(
          `"/workspace/repo" = "${["planning", "review"].includes(role.capability) ? "read" : "write"}"`
        )
        expect(initial.command).toContain("project_doc_max_bytes=0")
        expect(initial.command).toContain("--skip-git-repo-check")
      }
    }
  )

  it("refuses unsupported combinations and changed frozen versions", () => {
    expect(() =>
      executionConfig("@cf/zai-org/glm-5.3-flash", "codex")
    ).toThrow()
    expect(() =>
      harnessInvocation(
        { ...executionConfig("openai/gpt-6-luna", "codex"), version: "other" },
        roles[0]!,
        gateway,
        "/workspace/repo",
        "x"
      )
    ).toThrow("version")
  })

  it("checks native success events as well as process exit", () => {
    const output = (stdout: string, exitCode = 0) => ({
      stdout,
      exitCode,
      stderr: "",
    })
    expect(
      harnessResult(
        "claude-code",
        output(
          '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Unauthorized"}'
        )
      ).error
    ).toBe("Unauthorized")
    expect(
      harnessResult(
        "claude-code",
        output(
          '{"type":"result","subtype":"success","is_error":false,"result":"{}","session_id":"s"}'
        )
      )
    ).toMatchObject({ summary: "{}", error: null, sessionId: "s" })
    const codex = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}',
      '{"type":"turn.completed"}',
    ].join("\n")
    expect(harnessResult("codex", output(codex))).toMatchObject({
      summary: "{}",
      error: null,
      sessionId: "t",
    })
    expect(harnessResult("codex", output(codex, 1)).error).toContain("exited")
    for (const harness of ["codex", "claude-code", "opencode"] as const) {
      expect(
        harnessResult(harness, output("malformed\n{}\n")).error
      ).toBeTruthy()
      expect(
        harnessResult(harness, { ...output(codex), outputTruncated: true })
          .error
      ).toBeTruthy()
    }
    expect(
      harnessResult(
        "codex",
        output('{"type":"turn.failed","error":{"message":"rate limited"}}')
      ).error
    ).toBe("rate limited")
  })

  it("filters private tool inputs and outputs in the Sandbox", () => {
    const directory = mkdtempSync(join(tmpdir(), "terminus-events-"))
    try {
      const script = join(directory, "filter.mjs"),
        events = join(directory, "events.jsonl")
      writeFileSync(script, nativeHarnessEventFilterScript)
      writeFileSync(
        events,
        [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", name: "Read", input: "PRIVATE-INPUT" },
              ],
            },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "command_execution", output: "PRIVATE-OUTPUT" },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "{}",
            session_id: "s",
            hidden: "PRIVATE-REASONING",
          }),
        ].join("\n")
      )
      const filtered = execFileSync(process.execPath, [script, events], {
        encoding: "utf8",
      })
      expect(filtered).not.toContain("PRIVATE")
      expect(
        harnessResult("claude-code", {
          exitCode: 0,
          stdout: filtered,
          stderr: "",
        })
      ).toMatchObject({
        summary: "{}",
        tools: { Read: 1, command_execution: 1 },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
