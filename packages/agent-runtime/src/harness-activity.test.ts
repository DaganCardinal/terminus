import { spawn, type ChildProcess } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentActivitySchema } from "@terminus/protocol"
import {
  filteredHarnessActivity,
  liveHarnessActivityScript,
  liveHarnessFollowerScript,
  liveHarnessHeartbeat,
} from "./harness-activity"
import {
  maxRejectedFinalizations,
  maxRejectedPlanCalls,
  maxRepeatedPlanFormatFailures,
  notSavedReply,
  planAcceptedReply,
  planToolAgentName,
  planToolNames,
} from "./dispatch-draft"

const finalizeTool = planToolAgentName(planToolNames.finalize)
const stationTool = planToolAgentName(planToolNames.station)

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
    // The filter runs in the Sandbox as source text, so it names the plan
    // tools literally; these must match the names OpenCode gives them.
    for (const name of [
      planToolNames.outline,
      planToolNames.station,
      planToolNames.inspect,
    ])
      expect(
        filteredHarnessActivity(
          "opencode",
          tool(planToolAgentName(name), { goal: "PRIVATE" }),
          directory
        )
      ).toEqual({ kind: "phase", phase: "writing_plan" })
    expect(
      filteredHarnessActivity("opencode", tool(finalizeTool, {}), directory)
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
      "{}",
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
      "{}",
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
  const planCall = (tool: string, output: string) =>
    JSON.stringify(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool,
          state: { status: "completed", input: { goal: "PRIVATE" }, output },
        },
      })
    )
  const script = (lines: string[], keepAlive = true) =>
    `${lines.map((line) => `console.log(${line})`).join(";")}; ${keepAlive ? "setInterval(() => {}, 1000)" : "setTimeout(() => {}, 200)"}`

  // OpenCode emits this when malformed arguments never reach the MCP server.
  const invalidCall = (name = stationTool) =>
    JSON.stringify(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "invalid",
          state: {
            status: "completed",
            input: {
              tool: name,
              error: 'JSON parsing failed: {"scope":Only the footer PRIVATE}',
            },
            output: "The arguments provided to the tool are invalid: PRIVATE",
          },
        },
      })
    )

  it("pauses repeated malformed calls before they reach the plan server", async () => {
    const { exit, output, events } = await runLive(
      script(Array<string>(maxRepeatedPlanFormatFailures).fill(invalidCall()))
    )
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_stalled",
    })
    expect(output).not.toContain("PRIVATE")
    expect(events).toContain("JSON parsing failed")
  })

  it("pauses repeated schema-format failures but lets assessment corrections continue", async () => {
    const stalled = await runLive(
      script(
        Array<string>(maxRepeatedPlanFormatFailures).fill(
          planCall(
            stationTool,
            `${notSavedReply} Station does not match the put_station schema. PRIVATE`
          )
        )
      )
    )
    expect(stalled.exit?.stopped).toBe("proposal_stalled")
    const assessment = await runLive(
      script(
        Array<string>(maxRepeatedPlanFormatFailures).fill(
          planCall(
            planToolAgentName(planToolNames.outline),
            `${notSavedReply} the outline has problems that would block launch. PRIVATE`
          )
        ),
        false
      )
    )
    expect(assessment.exit).toEqual({ type: "harness_exit", exitCode: 0 })
  })

  it("resets repeated-format detection when a piece saves or the failing tool changes", async () => {
    const { exit } = await runLive(
      script(
        [
          ...Array<string>(maxRepeatedPlanFormatFailures - 1).fill(
            invalidCall()
          ),
          planCall(stationTool, "Saved Station `a`."),
          ...Array<string>(maxRepeatedPlanFormatFailures - 1).fill(
            invalidCall()
          ),
          invalidCall(planToolAgentName(planToolNames.outline)),
          invalidCall(),
        ],
        false
      )
    )
    expect(exit).toEqual({ type: "harness_exit", exitCode: 0 })
  })

  it("stops the harness once the plan is finalized", async () => {
    const started = Date.now()
    const { code, exit, events } = await runLive(
      script([planCall(finalizeTool, `${planAcceptedReply} use it.`)])
    )
    expect(code).toBe(0)
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_accepted",
    })
    expect(events).toContain(finalizeTool)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it("lets the harness continue after rejected pieces and finalizations", async () => {
    const { exit } = await runLive(
      script(
        [
          planCall(stationTool, `${notSavedReply} PRIVATE`),
          planCall(finalizeTool, "Not accepted. PRIVATE"),
          // A saved piece never counts, whatever problems it reports.
          ...Array<string>(maxRejectedPlanCalls).fill(
            planCall(stationTool, "Saved Station `a`. Problems: PRIVATE")
          ),
        ],
        false
      )
    )
    expect(exit).toEqual({ type: "harness_exit", exitCode: 0 })
  })

  it("stops the harness after repeated rejected finalizations", async () => {
    const { exit, output } = await runLive(
      script(
        Array<string>(maxRejectedFinalizations).fill(
          planCall(finalizeTool, "Not accepted. PRIVATE")
        )
      )
    )
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_rejected",
    })
    expect(output).not.toContain("PRIVATE")
  })

  it("stops the harness after repeated unsaved pieces, counting unparseable calls", async () => {
    const unparsed = JSON.stringify(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "invalid",
          state: {
            status: "completed",
            input: { tool: stationTool, error: "PRIVATE" },
            output: "The arguments provided to the tool are invalid: PRIVATE",
          },
        },
      })
    )
    const lines = [
      unparsed,
      ...Array<string>(maxRejectedPlanCalls - 1).fill(
        planCall(stationTool, `${notSavedReply} PRIVATE`)
      ),
    ]
    const started = Date.now()
    const { code, exit, output } = await runLive(script(lines))
    expect(code).toBe(0)
    expect(exit).toEqual({
      type: "harness_exit",
      exitCode: 0,
      stopped: "proposal_rejected",
    })
    expect(output).not.toContain("PRIVATE")
    expect(Date.now() - started).toBeLessThan(4000)
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

describe("live harness follower", () => {
  const read = (path: string) =>
    `console.log(${JSON.stringify(JSON.stringify(tool("read", { filePath: path })))})`
  /** A harness that reads two files, then a third later, then answers. */
  const slowHarness = `${read("src/a.ts")}; ${read("src/b.ts")}; setTimeout(() => { ${read("src/c.ts")}; console.log(JSON.stringify({ type: "text", part: { text: "PRIVATE FINAL" } })) }, 800)`
  const endlessHarness = "setInterval(() => {}, 1000)"

  function processRunning(pid: number) {
    try {
      // Container PID 1 may leave a killed descendant as a zombie.
      if (existsSync("/proc/self/stat")) {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        if ("ZX".includes(stat[stat.lastIndexOf(")") + 2]!)) return false
      }
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function setup() {
    const temp = mkdtempSync(join(tmpdir(), "terminus-live-follow-"))
    const runner = join(temp, "live.mjs"),
      follower = join(temp, "follow.mjs"),
      events = join(temp, "events.jsonl"),
      activity = join(temp, "run.activity.jsonl")
    writeFileSync(runner, liveHarnessActivityScript)
    writeFileSync(follower, liveHarnessFollowerScript)
    const follow = (args: string[]) => {
      const child = spawn(process.execPath, [follower, ...args])
      let output = ""
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      return {
        child,
        closed,
        /** Complete lines so far: a partial line is read again in full after reattaching. */
        lines: () => output.split("\n").slice(0, -1),
      }
    }
    const start = (harness: string, options: Record<string, unknown> = {}) =>
      follow([
        "start",
        activity,
        process.execPath,
        runner,
        events,
        "opencode",
        temp,
        JSON.stringify({
          heartbeat: liveHarnessHeartbeat(activity),
          ...options,
        }),
        process.execPath,
        "-e",
        harness,
      ])
    const pid = () => Number(readFileSync(`${activity}.pid`, "utf8"))
    const running = () => processRunning(pid())
    const descendantFile = join(temp, "descendant.json")
    const descendantPids = () =>
      JSON.parse(readFileSync(descendantFile, "utf8")) as {
        harness: number
        descendant: number
      }
    const followers: ChildProcess[] = []
    return {
      temp,
      events,
      activity,
      start: (...args: Parameters<typeof start>) => {
        const started = start(...args)
        followers.push(started.child)
        return started
      },
      attach: (lines: number) => {
        const attached = follow(["attach", activity, String(lines)])
        followers.push(attached.child)
        return attached
      },
      stop: () => follow(["stop", activity]).closed,
      running,
      descendantReady: () => existsSync(descendantFile),
      descendantRunning: () => processRunning(descendantPids().descendant),
      // The descendant holds the harness's stdout/stderr open even if its
      // parent exits, reproducing the timeout's missing close/outcome.
      withDescendant: (ignoreTerm = false, parentExits = false) => {
        const code = `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
          require("node:fs").writeFileSync(${JSON.stringify(descendantFile)}, JSON.stringify({ harness: Number(process.argv[1]), descendant: process.pid }));
          setInterval(() => {}, 1000)`
        return `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(code)}, String(process.pid)], { stdio: "inherit" });
          ${parentExits ? "child.unref()" : endlessHarness}`
      },
      cleanup: () => {
        for (const child of followers) child.kill("SIGKILL")
        // Also clean up a failed regression test whose runner never stopped
        // its harness, including the harness's separate process group.
        if (existsSync(descendantFile)) {
          const { harness, descendant } = descendantPids()
          const targets = [harness, descendant].filter(
            (target) => Number.isInteger(target) && target > 1
          )
          if (targets.includes(harness)) targets.unshift(-harness)
          for (const target of targets)
            try {
              process.kill(target, "SIGKILL")
            } catch {
              /* Already stopped. */
            }
        }
        if (existsSync(`${activity}.pid`) && running())
          process.kill(-pid(), "SIGKILL")
        rmSync(temp, { recursive: true, force: true })
      },
    }
  }
  async function until(condition: () => boolean, ms = 5000) {
    const deadline = Date.now() + ms
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const parsed = (lines: string[]) =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>)

  it("keeps the harness running when its follower is lost, and a new follower continues after the lines already handled", async () => {
    const f = setup()
    try {
      const first = f.start(slowHarness, { timeoutMs: 20_000 })
      await until(() => first.lines().length >= 2)
      // The stream is lost: the Sandbox aborts the streamed command.
      first.child.kill("SIGKILL")
      await first.closed
      const handled = first.lines()
      expect(f.running()).toBe(true)
      const second = f.attach(handled.length)
      expect(await second.closed).toBe(0)
      const lines = [...handled, ...second.lines()]
      // Exactly the runner's lines, each once.
      expect(lines).toEqual(
        readFileSync(f.activity, "utf8").split("\n").slice(0, -1)
      )
      expect(
        parsed(lines)
          .filter((line) => line.type === "activity")
          .map((line) => (line.activity as { path: string }).path)
      ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
      expect(parsed(lines).at(-1)).toEqual({
        type: "harness_exit",
        exitCode: 0,
      })
      expect(lines.join("\n")).not.toContain("PRIVATE")
      expect(readFileSync(f.events, "utf8")).toContain("PRIVATE FINAL")
      expect(f.running()).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it("stops a harness no follower has reported for, since orchestration is gone", async () => {
    const f = setup()
    try {
      const first = f.start(endlessHarness, { orphanMs: 1500 })
      await until(() => existsSync(`${f.activity}.pid`))
      // An attached follower keeps it running past the orphan limit.
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(f.running()).toBe(true)
      first.child.kill("SIGKILL")
      await until(() => !f.running(), 8000)
      expect(
        parsed(readFileSync(f.activity, "utf8").split("\n").slice(0, -1)).at(-1)
      ).toMatchObject({
        type: "harness_exit",
        exitCode: 143,
        signal: "SIGTERM",
      })
    } finally {
      f.cleanup()
    }
  }, 12_000)

  it("stops the harness at its own time limit and says so", async () => {
    const f = setup()
    try {
      const run = f.start(endlessHarness, { timeoutMs: 300 })
      expect(await run.closed).toBe(0)
      expect(parsed(run.lines()).at(-1)).toMatchObject({
        type: "harness_exit",
        exitCode: 143,
        signal: "SIGTERM",
        timedOut: true,
      })
    } finally {
      f.cleanup()
    }
  })

  it.each([false, true])(
    "times out descendants holding inherited pipes, even if the harness already exited (%s)",
    async (parentExits) => {
      const f = setup()
      try {
        const run = f.start(f.withDescendant(false, parentExits), {
          timeoutMs: 800,
        })
        await until(f.descendantReady)
        await until(() => !f.running(), 3000)
        expect(await run.closed).toBe(0)
        expect(parsed(run.lines()).at(-1)).toMatchObject({
          type: "harness_exit",
          timedOut: true,
        })
        await until(() => !f.descendantRunning())
        expect(f.running()).toBe(false)
      } finally {
        f.cleanup()
      }
    }
  )

  it("force-kills descendants that ignore SIGTERM before reporting the timeout", async () => {
    const f = setup()
    try {
      const run = f.start(f.withDescendant(true), { timeoutMs: 800 })
      await until(f.descendantReady)
      await until(() => !f.running(), 8000)
      expect(await run.closed).toBe(0)
      expect(parsed(run.lines()).at(-1)).toMatchObject({
        type: "harness_exit",
        timedOut: true,
      })
      await until(() => !f.descendantRunning())
      expect(f.running()).toBe(false)
    } finally {
      f.cleanup()
    }
  }, 10_000)

  it("stops descendants when the follower is gone", async () => {
    const f = setup()
    try {
      const run = f.start(f.withDescendant(), { orphanMs: 500 })
      await until(f.descendantReady)
      run.child.kill("SIGKILL")
      await run.closed
      await until(() => !f.running())
      await until(() => !f.descendantRunning())
      expect(
        parsed(readFileSync(f.activity, "utf8").split("\n").slice(0, -1)).at(-1)
      ).toMatchObject({
        type: "harness_exit",
        exitCode: 143,
        signal: "SIGTERM",
      })
    } finally {
      f.cleanup()
    }
  })

  it("stops the runner and its harness on request, ending its follower", async () => {
    const f = setup()
    try {
      const run = f.start(f.withDescendant())
      await until(f.descendantReady)
      expect(f.running()).toBe(true)
      await f.stop()
      expect(await run.closed).toBe(0)
      expect(f.running()).toBe(false)
      await until(() => !f.descendantRunning())
    } finally {
      f.cleanup()
    }
  })
})
