import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentActivitySchema } from "@terminus/protocol"
import {
  filteredHarnessActivity,
  liveHarnessActivityScript,
} from "./harness-activity"
import {
  maxRejectedSubmissions,
  proposalAcceptedReply,
  proposalToolAgentName,
} from "./opencode"

const directory = "/workspace/repo"
function tool(name: string, input: unknown, status = "completed") {
  return {
    type: "tool_use",
    part: {
      tool: name,
      state: {
        input,
        status,
        output: "PRIVATE OUTPUT",
        error: "PRIVATE ERROR",
      },
    },
  }
}

describe("filtered harness activity", () => {
  it("allowlists tool metadata and rejects reasoning, text and unknown tools", () => {
    expect(
      filteredHarnessActivity(
        "opencode",
        tool("read", {
          filePath: `${directory}/src/App.tsx`,
          secret: "PRIVATE",
        }),
        directory
      )
    ).toEqual({
      kind: "tool",
      tool: "read",
      status: "completed",
      path: "src/App.tsx",
    })
    for (const event of [
      null,
      {},
      { type: "reasoning", part: { text: "PRIVATE" } },
      { type: "text", part: { text: "PRIVATE" } },
      tool("unknown", {}),
    ]) {
      expect(filteredHarnessActivity("opencode", event, directory)).toBeNull()
    }
    expect(
      filteredHarnessActivity(
        "opencode",
        tool("task", {
          subagent_type: "explore",
          prompt: "PRIVATE",
          description: "PRIVATE",
        }),
        directory
      )
    ).toEqual({ kind: "tool", tool: "explore", status: "completed" })
    expect(
      filteredHarnessActivity(
        "opencode",
        tool("task", { subagent_type: "general" }),
        directory
      )
    ).toBeNull()
    expect(
      filteredHarnessActivity(
        "opencode",
        tool("grep", { pattern: "PRIVATE" }),
        directory
      )
    ).toEqual({ kind: "tool", tool: "search", status: "completed" })
    expect(
      filteredHarnessActivity(
        "opencode",
        tool("terminus_submit_proposal", { proposal: "PRIVATE" }),
        directory
      )
    ).toEqual({ kind: "phase", phase: "validating_proposal" })
  })

  it.each([
    "/etc/passwd",
    "../secret",
    "src/../.env",
    ".env.local",
    "config/key.pem",
    "https://host/token",
    "a\nPRIVATE",
    ".git/config",
    "x".repeat(201),
  ])("drops unsafe path %s", (path) => {
    const result = filteredHarnessActivity(
      "opencode",
      tool("read", { filePath: path }),
      directory
    )
    expect(result).toEqual({ kind: "tool", tool: "read", status: "completed" })
    expect(agentActivitySchema.safeParse(result).success).toBe(true)
  })

  it("normalizes native harness tools without shell arguments or results", () => {
    expect(
      filteredHarnessActivity(
        "claude-code",
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "src/a.ts" },
              },
            ],
          },
        },
        directory
      )
    ).toEqual({
      kind: "tool",
      tool: "read",
      status: "running",
      path: "src/a.ts",
    })
    expect(
      filteredHarnessActivity(
        "codex",
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "PRIVATE",
            aggregated_output: "PRIVATE",
            exit_code: 1,
          },
        },
        directory
      )
    ).toEqual({ kind: "tool", tool: "command", status: "failed" })
  })

  it("emits activity before the harness exits, keeping its raw transcript local", async () => {
    const temp = mkdtempSync(join(tmpdir(), "terminus-live-activity-"))
    const script = join(temp, "live.mjs"),
      events = join(temp, "events.jsonl")
    writeFileSync(script, liveHarnessActivityScript)
    const event = tool("read", { filePath: "src/a.ts", description: "PRIVATE" })
    const command = `console.log(${JSON.stringify(JSON.stringify(event))}); setTimeout(() => { console.log(JSON.stringify({type:"text",part:{text:"PRIVATE FINAL"}})) }, 250)`
    const child = spawn(process.execPath, [
      script,
      events,
      "opencode",
      temp,
      process.execPath,
      "-e",
      command,
    ])
    let output = "",
      stderr = "",
      exited = false
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => {
        exited = true
        resolve(code)
      })
    })
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk) => {
          output += chunk.toString()
          if (output.includes('"activity"')) resolve()
        })
      })
      expect(exited).toBe(false)
      expect(await done, stderr).toBe(0)
      expect(output).not.toContain("PRIVATE")
      expect(output).toContain('"harness_exit","exitCode":0')
      expect(readFileSync(events, "utf8")).toContain("PRIVATE FINAL")
    } finally {
      child.kill()
      rmSync(temp, { recursive: true, force: true })
    }
  })

  /** Runs the live script over a Node one-liner standing in for the harness. */
  async function runLive(command: string) {
    const temp = mkdtempSync(join(tmpdir(), "terminus-live-exit-"))
    const script = join(temp, "live.mjs"),
      events = join(temp, "events.jsonl")
    writeFileSync(script, liveHarnessActivityScript)
    const child = spawn(process.execPath, [
      script,
      events,
      "opencode",
      temp,
      process.execPath,
      "-e",
      command,
    ])
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      const exit = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.type === "harness_exit")
      return { code, exit, output, events: readFileSync(events, "utf8") }
    } finally {
      child.kill()
      rmSync(temp, { recursive: true, force: true })
    }
  }
  const submission = (output: string) =>
    JSON.stringify(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: proposalToolAgentName,
          state: { status: "completed", input: { proposal: {} }, output },
        },
      })
    )

  it("stops the harness once a proposal is accepted, keeping the submission", async () => {
    const started = Date.now()
    const { code, exit, events } = await runLive(
      `console.log(${submission(`${proposalAcceptedReply} use it.`)}); setInterval(() => {}, 1000)`
    )
    expect(code).toBe(0)
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_accepted",
    })
    expect(events).toContain(proposalToolAgentName)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it("lets the harness continue after a rejected submission", async () => {
    const { exit } = await runLive(
      `console.log(${submission("Not accepted. PRIVATE")}); setTimeout(() => {}, 200)`
    )
    expect(exit).toEqual({ type: "harness_exit", exitCode: 0 })
  })

  it("stops the harness after repeated rejected submissions, counting unparseable calls", async () => {
    const unparsed = JSON.stringify(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "invalid",
          state: {
            status: "completed",
            input: { tool: proposalToolAgentName, error: "PRIVATE" },
            output: "The arguments provided to the tool are invalid: PRIVATE",
          },
        },
      })
    )
    const rejected = submission("Not accepted. PRIVATE")
    const lines = [
      unparsed,
      ...Array<string>(maxRejectedSubmissions - 1).fill(rejected),
    ]
    const started = Date.now()
    const { code, exit, output } = await runLive(
      `${lines.map((line) => `console.log(${line})`).join(";")}; setInterval(() => {}, 1000)`
    )
    expect(code).toBe(0)
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_rejected",
    })
    expect(output).not.toContain("PRIVATE")
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it("reports each model step as it ends, and the step a stop cut off", async () => {
    const events = [
      { type: "step_start", timestamp: 1_000 },
      { type: "step_finish", timestamp: 1_200, part: { reason: "tool-calls" } },
      { type: "step_start", timestamp: 1_300 },
    ]
    const { output } = await runLive(
      `${events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(";")}; setTimeout(() => { console.log(${submission(`${proposalAcceptedReply} use it.`)}) }, 250); setInterval(() => {}, 1000)`
    )
    const lines = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type !== "activity")
    expect(lines.map((line) => [line.type, line.step])).toEqual([
      ["perf_step", 1],
      ["perf_step", 2],
      ["harness_exit", undefined],
    ])
    expect(lines[1]!.tools).toEqual([
      expect.objectContaining({ tool: proposalToolAgentName }),
    ])
  })

  it("reports a signal and the end of stderr after an abnormal exit", async () => {
    const failed = await runLive(
      `process.stderr.write("x".repeat(2000) + "\\u001b[31mfatal: provider stream closed\\u0007"); process.exitCode = 3`
    )
    expect(failed.exit).toMatchObject({ exitCode: 3 })
    const tail = failed.exit!.stderrTail as string
    expect(tail.endsWith("fatal: provider stream closed")).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(800)
    expect(failed.output).not.toContain("\\u001b")

    const killed = await runLive(`process.kill(process.pid, "SIGTERM")`)
    expect(killed.exit).toMatchObject({ exitCode: 143, signal: "SIGTERM" })
  })
})
