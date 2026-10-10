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
  type HarnessAgent,
} from "@terminus/agent-runtime"
import type { GitWorkspace } from "@terminus/artifacts"
import {
  commandResultSchema,
  type CommandResult,
  type RoleExecution,
  type Harness,
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
        ...(execution.harness === "codex" ? ["/etc/codex"] : []),
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
    close: () => sandbox.close(),
  }
}

export interface HarnessSessionOptions {
  /** The role's name in operational logs. */
  role: string
  model: string
  execution?: RoleExecution
  /** The sealed checkout the agent works in. */
  directory: string
  /** The first answer explores; corrections reuse that context. */
  startTimeoutMs: number
  resumeTimeoutMs: number
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
    const output = await runPreparedHarness(
      this.#sandbox,
      prepared,
      directory,
      timeoutMs,
      `session-${++this.#runs}`
    )
    const result = harnessResult(prepared.harness, output)
    console.info(`${role} harness completed`, {
      run: this.#runs,
      durationMs: Date.now() - started,
      exitCode: output.exitCode,
      tools: harnessToolCounts(output),
    })
    this.#session ??= result.sessionId
    if (result.error) throw new Error(result.error)
    return result.summary ?? ""
  }
}

/** Capture potentially large tool events locally; only normalized outcomes leave the Sandbox. */
export async function runPreparedHarness(
  sandbox: Pick<StationSandbox, "write" | "run">,
  prepared: PreparedHarness,
  directory: string,
  timeoutMs?: number,
  identity = crypto.randomUUID()
): Promise<CommandResult> {
  const events = `/workspace/harness-${identity}.jsonl`
  const script = "/workspace/harness-events.mjs"
  await sandbox.write(
    script,
    prepared.harness === "opencode"
      ? harnessEventFilterScript
      : nativeHarnessEventFilterScript
  )
  const run = commandResultSchema.parse(
    await sandbox.run(
      ["bash", "-c", 'exec "$@" > "$0"', events, ...prepared.command],
      directory,
      prepared.env,
      timeoutMs
    )
  )
  const filtered = commandResultSchema.parse(
    await sandbox.run(["node", script, events], "/workspace")
  )
  if (filtered.exitCode !== 0)
    throw new Error("Harness output could not be read")
  return {
    exitCode: run.exitCode,
    stdout: filtered.stdout,
    stderr: "",
    outputTruncated: !!filtered.outputTruncated,
  }
}
