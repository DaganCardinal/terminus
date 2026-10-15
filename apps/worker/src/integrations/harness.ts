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
  liveHarnessFollowerScript,
  liveHarnessHeartbeat,
  ProposalSubmissionsExhausted,
  PlanToolFormatStalled,
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
import { harnessExecutionEnabled } from "./harness-availability"
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
  if (!harnessExecutionEnabled(env, execution.harness, gateway.provider))
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
    if (output.stopped === "proposal_stalled") throw new PlanToolFormatStalled()
    // Stopped because its plan was accepted: the saved draft is the answer,
    // and is reviewed again, so a missing closing message is not a failure.
    if (output.stopped === "proposal_accepted") return result.summary ?? ""
    if (result.error) throw new Error(result.error)
    return result.summary ?? ""
  }
}

const liveRunner = "/workspace/harness-live.mjs"
const liveFollower = "/workspace/harness-follow.mjs"
/** Matches the Sandbox's own default command limit. */
const defaultHarnessTimeoutMs = 20 * 60_000
/** A follower outlasts its runner's own time limit, so the runner reports a timeout itself. */
const followerGraceMs = 60_000
/** Pauses before each attempt to follow a live harness again after its stream is lost. The
 * first is immediate, since a dropped stream usually leaves a healthy container; together they
 * stay well inside the runner's orphan limit. */
const reattachPausesMs = [0, 500, 1500]
/** Bounds reattaching a run whose stream keeps dropping. */
const maxReattaches = 8

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
  const activity = `/workspace/harness-${identity}-${crypto.randomUUID()}.activity.jsonl`
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
  // A live runner may outlive a failed run; it is stopped before this returns.
  let launched = false
  try {
    run = await perfSpan(
      "harness.process",
      { identity, harness: prepared.harness },
      async () => {
        if (onActivity && sandbox.runStream) {
          const limitMs = timeoutMs ?? defaultHarnessTimeoutMs
          await sandbox.write(liveRunner, liveHarnessActivityScript)
          await sandbox.write(liveFollower, liveHarnessFollowerScript)
          const deadline = Date.now() + limitMs + followerGraceMs
          launched = true
          // The runner starts detached, so a lost stream takes down only its follower.
          const stream = await sandbox.runStream(
            [
              "node",
              liveFollower,
              "start",
              activity,
              "node",
              liveRunner,
              events,
              prepared.harness,
              directory,
              JSON.stringify({
                timeoutMs: limitMs,
                heartbeat: liveHarnessHeartbeat(activity),
              }),
              ...prepared.command,
            ],
            directory,
            prepared.env,
            limitMs + followerGraceMs
          )
          liveSteps = true
          let reattaches = 0
          const { exitCode, ...rest } = await consumeHarnessActivity(
            stream,
            onActivity,
            (step) =>
              perf("harness.step", { ...timeline, ...step, live: true }),
            async (lines, lost) => {
              for (const pauseMs of reattachPausesMs) {
                if (
                  reattaches >= maxReattaches ||
                  Date.now() + pauseMs >= deadline
                )
                  break
                reattaches++
                if (pauseMs) await scheduler.wait(pauseMs)
                const attempted = Date.now()
                const fields = {
                  ...timeline,
                  identity,
                  attempt: reattaches,
                  lines,
                  lost: errorDetail(lost),
                }
                try {
                  const resumed = await sandbox.runStream!(
                    ["node", liveFollower, "attach", activity, String(lines)],
                    "/workspace",
                    {},
                    Math.max(deadline - Date.now(), 1000),
                    { reattach: true }
                  )
                  perf("harness.reattach", {
                    ...fields,
                    ok: true,
                    ms: Date.now() - attempted,
                  })
                  return resumed
                } catch (error) {
                  perf("harness.reattach", {
                    ...fields,
                    ok: false,
                    error: errorKind(error),
                    detail: errorDetail(error),
                    ms: Date.now() - attempted,
                  })
                }
              }
              return null
            }
          )
          exit = rest
          if (rest.timedOut)
            throw new Error(
              `Harness timed out after ${Math.round(limitMs / 1000)} seconds`
            )
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
    if (launched)
      await sandbox
        .run(["node", liveFollower, "stop", activity], "/workspace")
        .catch(() => {})
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
  /** Set when the live runner ended the harness: its work was done, it
   * reached a rejection limit, or a format loop needs a session correction. */
  stopped?: "proposal_accepted" | "proposal_rejected" | "proposal_stalled"
  /** The live runner stopped the harness at its time limit. */
  timedOut?: true
  /** For diagnosis only: the signal and end of stderr after an abnormal exit. */
  signal?: string
  stderrTail?: string
}

/** Follows the harness again after a lost stream, skipping the `lines` complete lines already
 * handled; resolves to null when it cannot, and the run fails with what lost the stream. */
export type HarnessReattach = (
  lines: number,
  lost: unknown
) => Promise<ReadableStream<Uint8Array> | null>

/** The pipe contains filtered observations, never the raw harness transcript. */
export async function consumeHarnessActivity(
  stream: ReadableStream<Uint8Array>,
  observe: ActivityObserver,
  /** TEMPORARY benchmark instrumentation: one finished model step. */
  onStep?: (step: Record<string, unknown>) => void,
  reattach?: HarnessReattach
): Promise<HarnessExit> {
  let exit: HarnessExit | undefined
  let lines = 0
  const line = (text: string) => {
    let event: {
      type?: string
      activity?: unknown
      exitCode?: unknown
      stopped?: unknown
      timedOut?: unknown
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
        event.stopped === "proposal_rejected" ||
        event.stopped === "proposal_stalled"
      )
        exit.stopped = event.stopped
      if (event.timedOut === true) exit.timedOut = true
      if (typeof event.signal === "string")
        exit.signal = event.signal.slice(0, 20)
      if (typeof event.stderrTail === "string")
        exit.stderrTail = stderrTail(event.stderrTail)
    }
  }
  /** Reads one stream to its end, returning what lost it, if anything did. */
  const read = async (
    current: ReadableStream<Uint8Array>
  ): Promise<{ lost: unknown } | undefined> => {
    const decoder = new TextDecoder()
    const reader = current.getReader()
    let buffer = ""
    try {
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch (lost) {
          // A partial line is discarded and read again in full after reattaching.
          return { lost }
        }
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, end))
          lines++
          buffer = buffer.slice(end + 1)
        }
        if (buffer.length > 65536) throw new Error("Invalid activity stream")
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    }
    buffer += decoder.decode()
    if (buffer) line(buffer)
    return undefined
  }
  for (let current = stream; ;) {
    const result = await read(current)
    if (!result) break
    // Losing the stream need not mean losing the harness, which runs on in the Sandbox.
    const resumed = reattach ? await reattach(lines, result.lost) : null
    if (resumed) {
      current = resumed
      continue
    }
    // The runner's exit line is its last, so a run whose outcome arrived is over.
    if (exit) return exit
    throw result.lost
  }
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
