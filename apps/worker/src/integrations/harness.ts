import {
  harnessEventFilterScript,
  harnessMessage,
  harnessPreflightCommand,
  harnessPreflightGuidance,
  harnessToolCounts,
  harnessInvocation,
  harnessResult,
  nativeHarnessEventFilterScript,
  executionConfig,
  harnessVersionCommand,
  installedHarnessVersion,
  logHarnessTimeline,
  liveHarnessActivityScript,
  ProposalSubmissionsExhausted,
  type HarnessAgent,
} from "@terminus/agent-runtime"
import type { GitWorkspace } from "@terminus/artifacts"
import {
  commandResultSchema,
  errorDetail,
  errorKind,
  perf,
  perfSpan,
  type CommandResult,
  type RoleExecution,
  type Harness,
  agentActivitySchema,
  type ActivityObserver,
} from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import type { StationSandbox } from "./station-runner"

export interface HarnessRequest {
  model: string
  execution?: RoleExecution
  agent: HarnessAgent
  /** The untrusted checkout the agent works in. */
  directory: string
  /** The role's assignment; root repository guidance is attached as data. */
  assignment: string
}

export interface PreparedHarness {
  harness: Harness
  command: string[]
  env: Record<string, string>
}

/**
 * Prepares any role's harness run over an untrusted checkout. Call it
 * immediately before running the harness: it writes the only configuration
 * the harness loads, and removes user-level configuration that repository
 * code may have written since the Sandbox started.
 */
export async function prepareHarness(
  env: Env,
  sandbox: Pick<StationSandbox, "write">,
  workspace: Pick<GitWorkspace, "run">,
  request: HarnessRequest
): Promise<PreparedHarness> {
  const execution = request.execution ?? executionConfig(request.model)
  if (execution.model !== request.model)
    throw new Error("Harness configuration differs from its frozen model grant")
  const gateway = gatewayConfig(env, request.model)
  if (
    (execution.harness !== "opencode" || gateway.provider !== "workers-ai") &&
    env.ALTERNATIVE_HARNESSES_ENABLED !== "true"
  )
    throw new Error(
      "Alternative harness execution is disabled until Cloudflare capability verification is complete"
    )
  const preflightStarted = Date.now()
  const guidance = harnessPreflightGuidance(
    commandResultSchema.parse(
      await workspace.run(harnessPreflightCommand(), request.directory)
    )
  )
  const invocation = harnessInvocation(
    execution,
    request.agent,
    gateway,
    request.directory,
    harnessMessage(request.assignment, guidance, crypto.randomUUID())
  )
  if (execution.harness !== "opencode") {
    const created = commandResultSchema.parse(
      await workspace.run([
        "mkdir",
        "-p",
        "/workspace/harness-state",
        // Codex refuses to start when CODEX_HOME does not exist.
        ...(execution.harness === "codex"
          ? [invocation.env.CODEX_HOME!, "/etc/codex"]
          : []),
      ])
    )
    if (created.exitCode !== 0)
      throw new Error("Could not create trusted harness configuration")
  }
  for (const [path, contents] of Object.entries(invocation.files))
    await sandbox.write(path, contents)
  installedHarnessVersion(
    execution.harness,
    commandResultSchema.parse(
      await workspace.run(
        harnessVersionCommand(execution.harness),
        request.directory,
        invocation.env
      )
    )
  )
  perf("harness.prepared", {
    agent: request.agent.name,
    harness: execution.harness,
    ms: Date.now() - preflightStarted,
    guidance: guidance
      ? {
          path: guidance.path,
          chars: guidance.content.length,
          truncated: guidance.truncated,
        }
      : null,
    systemPromptChars: request.agent.system.length,
    firstMessageChars: request.assignment.length,
  })
  return {
    command: invocation.command,
    env: invocation.env,
    harness: execution.harness,
  }
}

/** Sandbox commands for one role and phase, logged without arguments or output, which can hold repository content. */
export function loggedWorkspace(
  sandbox: StationSandbox,
  role: string,
  phase: string
): GitWorkspace {
  return {
    run: async (args, cwd, env) => {
      const started = Date.now()
      const result = commandResultSchema.parse(
        await sandbox.run(args, cwd, env)
      )
      console.info(`${role} command completed`, {
        phase,
        command: args[0],
        durationMs: Date.now() - started,
        exitCode: result.exitCode,
        outputTruncated: !!result.outputTruncated,
      })
      return result
    },
    install: async (cwd) =>
      commandResultSchema.parse(await sandbox.installDependencies(cwd)),
    close: () => sandbox.close(),
  }
}

export interface HarnessSessionOptions {
  /** The role's name in operational logs. */
  role: string
  /** TEMPORARY benchmark instrumentation: correlates timeline lines with their Sandbox. */
  label?: string
  model: string
  execution?: RoleExecution
  /** The sealed checkout the agent works in. */
  directory: string
  /** The first answer explores; corrections reuse that context. */
  startTimeoutMs: number
  resumeTimeoutMs: number
  onActivity?: ActivityObserver
}

/**
 * One native harness session in a Sandbox: started once, then resumed for in-context
 * corrections. Raw events, which include every file the agent read, stay in
 * the Sandbox; only the session id, final message, and tool-use counts leave it.
 */
export class HarnessSession {
  readonly #env: Env
  readonly #sandbox: StationSandbox
  readonly #options: HarnessSessionOptions
  #session: string | null = null
  #agent: HarnessAgent | undefined
  #runs = 0
  constructor(
    env: Env,
    sandbox: StationSandbox,
    options: HarnessSessionOptions
  ) {
    this.#env = env
    this.#sandbox = sandbox
    this.#options = options
  }

  async start(agent: HarnessAgent, assignment: string): Promise<string> {
    this.#agent = agent
    const prepared = await prepareHarness(
      this.#env,
      this.#sandbox,
      loggedWorkspace(this.#sandbox, this.#options.role, "preflight"),
      {
        model: this.#options.model,
        execution: this.#options.execution,
        agent,
        directory: this.#options.directory,
        assignment,
      }
    )
    return this.#run(prepared, this.#options.startTimeoutMs)
  }

  async resume(message: string): Promise<string> {
    if (!this.#session || !this.#agent)
      throw new Error(`${this.#options.role} session was not recorded`)
    const config =
      this.#options.execution ?? executionConfig(this.#options.model)
    const invocation = harnessInvocation(
      config,
      this.#agent,
      gatewayConfig(this.#env, config.model),
      this.#options.directory,
      message,
      this.#session
    )
    return this.#run(
      {
        command: invocation.command,
        env: invocation.env,
        harness: config.harness,
      },
      this.#options.resumeTimeoutMs
    )
  }

  async #run(prepared: PreparedHarness, timeoutMs: number): Promise<string> {
    const { role, directory } = this.#options
    const started = Date.now()
    this.#options.onActivity?.({ kind: "phase", phase: "exploring" })
    const output = await runPreparedHarness(
      this.#sandbox,
      prepared,
      directory,
      timeoutMs,
      `session-${++this.#runs}`,
      {
        role,
        sandbox: this.#options.label,
        run: this.#runs,
        kind: this.#runs === 1 ? "start" : "resume",
      },
      this.#options.onActivity
    )
    const result = harnessResult(prepared.harness, output)
    console.info(`${role} harness completed`, {
      run: this.#runs,
      durationMs: Date.now() - started,
      exitCode: output.exitCode,
      tools: harnessToolCounts(output),
    })
    logHarnessTimeline(
      {
        role,
        sandbox: this.#options.label,
        run: this.#runs,
        kind: this.#runs === 1 ? "start" : "resume",
        error: result.error?.slice(0, 300),
        finalChars: result.summary?.length,
      },
      output,
      Date.now() - started
    )
    this.#session ??= result.sessionId
    if (output.stopped === "proposal_rejected")
      throw new ProposalSubmissionsExhausted(result.summary ?? "")
    if (result.error) throw new Error(result.error)
    return result.summary ?? ""
  }
}

/** Capture potentially large tool events locally; only normalized outcomes leave the Sandbox. */
export async function runPreparedHarness(
  sandbox: Pick<StationSandbox, "write" | "run" | "runStream">,
  prepared: PreparedHarness,
  directory: string,
  timeoutMs?: number,
  identity = crypto.randomUUID(),
  /** TEMPORARY benchmark instrumentation: fields for a failed run's timeline. */
  timeline: Record<string, unknown> = {},
  onActivity?: ActivityObserver
): Promise<CommandResult & Pick<HarnessExit, "stopped">> {
  const events = `/workspace/harness-${identity}.jsonl`
  const script = "/workspace/harness-events.mjs"
  await sandbox.write(
    script,
    prepared.harness === "opencode"
      ? harnessEventFilterScript
      : nativeHarnessEventFilterScript
  )
  const started = Date.now()
  let run: CommandResult
  let exit: Omit<HarnessExit, "exitCode"> = {}
  // The live runner reports each step as it ends, so the run's later timeline omits them.
  let liveSteps = false
  try {
    run = await perfSpan(
      "harness.process",
      { identity, harness: prepared.harness },
      async () => {
        if (onActivity && sandbox.runStream) {
          const live = "/workspace/harness-live.mjs"
          await sandbox.write(live, liveHarnessActivityScript)
          const stream = await sandbox.runStream(
            [
              "node",
              live,
              events,
              prepared.harness,
              directory,
              ...prepared.command,
            ],
            directory,
            prepared.env,
            timeoutMs
          )
          liveSteps = true
          const { exitCode, ...rest } = await consumeHarnessActivity(
            stream,
            onActivity,
            (step) => perf("harness.step", { ...timeline, ...step, live: true })
          )
          exit = rest
          return { exitCode, stdout: "", stderr: "" }
        }
        const result = commandResultSchema.parse(
          await sandbox.run(
            ["bash", "-c", 'exec "$@" > "$0"', events, ...prepared.command],
            directory,
            prepared.env,
            timeoutMs
          )
        )
        if (result.exitCode !== 0)
          exit = { stderrTail: stderrTail(result.stderr) }
        return result
      },
      (result) => ({ exitCode: result.exitCode })
    )
  } catch (error) {
    await logFailedHarness(sandbox, script, events, liveSteps, {
      ...timeline,
      identity,
      error: errorKind(error),
      detail: errorDetail(error),
      ms: Date.now() - started,
    })
    throw error
  }
  // TEMPORARY benchmark instrumentation: why a harness stopped early or exited abnormally.
  if (run.exitCode !== 0 || exit.stopped)
    perf("harness.exit", {
      ...timeline,
      identity,
      exitCode: run.exitCode,
      ...exit,
      ms: Date.now() - started,
    })
  const filtered = await perfSpan(
    "harness.filter",
    { identity },
    async () =>
      commandResultSchema.parse(
        await sandbox.run(["node", script, events], "/workspace")
      ),
    (result) => ({
      outChars: result.stdout.length,
      truncated: !!result.outputTruncated,
    })
  )
  if (filtered.exitCode !== 0)
    throw new Error("Harness output could not be read")
  return {
    exitCode: run.exitCode,
    stdout: liveSteps ? withoutSteps(filtered.stdout) : filtered.stdout,
    stderr: "",
    outputTruncated: !!filtered.outputTruncated,
    ...(exit.stopped ? { stopped: exit.stopped } : {}),
  }
}

/** Drops the timeline's step lines, for runs whose steps were already logged live. */
function withoutSteps(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith('{"type":"perf_step"'))
    .join("\n")
}

/** Control characters other than tab and newline are dropped, and only the end is kept, where a fatal error appears. */
function stderrTail(stderr: string): string {
  return [...stderr]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || (code >= 32 && code !== 127)
    })
    .join("")
    .slice(-800)
}

export interface HarnessExit {
  exitCode: number
  /** Set when the live runner ended the harness: its work was done, or it
   * reached its limit of rejected plan tool calls. */
  stopped?: "proposal_accepted" | "proposal_rejected"
  /** For diagnosis only: the signal and end of stderr after an abnormal exit. */
  signal?: string
  stderrTail?: string
}

/** The pipe contains filtered observations, never the raw harness transcript. */
export async function consumeHarnessActivity(
  stream: ReadableStream<Uint8Array>,
  observe: ActivityObserver,
  /** TEMPORARY benchmark instrumentation: one finished model step. */
  onStep?: (step: Record<string, unknown>) => void
): Promise<HarnessExit> {
  const decoder = new TextDecoder()
  let buffer = ""
  let exit: HarnessExit | undefined
  const line = (text: string) => {
    let event: {
      type?: string
      activity?: unknown
      exitCode?: unknown
      stopped?: unknown
      signal?: unknown
      stderrTail?: unknown
    }
    try {
      event = JSON.parse(text) as typeof event
    } catch {
      return
    }
    if (event.type === "activity") {
      const parsed = agentActivitySchema.safeParse(event.activity)
      if (parsed.success) {
        try {
          observe(parsed.data)
        } catch {
          /* Observers never control execution. */
        }
      }
    } else if (event.type === "perf_step") {
      // JSON drops the `type: undefined` override, so the line type is not repeated.
      onStep?.({ ...event, type: undefined })
    } else if (
      event.type === "harness_exit" &&
      Number.isInteger(event.exitCode)
    ) {
      exit = { exitCode: event.exitCode as number }
      if (
        event.stopped === "proposal_accepted" ||
        event.stopped === "proposal_rejected"
      )
        exit.stopped = event.stopped
      if (typeof event.signal === "string")
        exit.signal = event.signal.slice(0, 20)
      if (typeof event.stderrTail === "string")
        exit.stderrTail = stderrTail(event.stderrTail)
    }
  }
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf("\n")) !== -1) {
      line(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
    if (buffer.length > 65536) throw new Error("Invalid activity stream")
  }
  buffer += decoder.decode()
  if (buffer) line(buffer)
  if (exit === undefined)
    throw new Error("Harness activity stream ended without an outcome")
  return exit
}

/**
 * TEMPORARY benchmark instrumentation: when the harness command itself
 * throws, logs its steps so far from the events file. A filter run that
 * restarts the container (`sandbox.exec` with `firstAfterColdStart`) or finds
 * no events file means the container died with the harness.
 */
async function logFailedHarness(
  sandbox: Pick<StationSandbox, "run">,
  script: string,
  events: string,
  liveSteps: boolean,
  fields: Record<string, unknown> & { ms: number }
): Promise<void> {
  try {
    const filtered = commandResultSchema.parse(
      await sandbox.run(["node", script, events], "/workspace")
    )
    perf("harness.failed", {
      ...fields,
      eventsReadable: filtered.exitCode === 0,
    })
    if (filtered.exitCode === 0)
      logHarnessTimeline(
        { ...fields, failed: true },
        liveSteps
          ? { ...filtered, stdout: withoutSteps(filtered.stdout) }
          : filtered,
        fields.ms
      )
  } catch (error) {
    perf("harness.failed", {
      ...fields,
      eventsReadable: false,
      filterError: errorKind(error),
    })
  }
}
