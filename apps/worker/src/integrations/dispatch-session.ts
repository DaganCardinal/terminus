import {
  dispatcherHarnessAgent,
  harnessEventFilterScript,
  harnessOutcome,
  harnessSessionId,
  harnessToolCounts,
  opencodeEnvironment,
  opencodeRunCommand,
  type DispatchSession,
  type HarnessAgent,
  type DispatchSessionFactory,
} from "@terminus/agent-runtime"
import {
  checkoutPlanningBaseline,
  planningDirectory,
  sealPlanningWorkspace,
  type ArtifactsRepositoryHost,
  type GitWorkspace,
  type RepositoryAccess,
} from "@terminus/artifacts"
import type { BaselineReport, CheckResult } from "@terminus/domain"
import {
  commandResultSchema,
  validationCommandsSchema,
  type CommandResult,
} from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import { prepareHarness, type PreparedHarness } from "./harness"
import { runProjectChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type OpenInput = Parameters<DispatchSessionFactory["open"]>[0]

/** The first answer explores; corrections reuse that context. */
const startTimeoutMs = 15 * 60_000
const resumeTimeoutMs = 5 * 60_000

export class SandboxDispatchSessions implements DispatchSessionFactory {
  private readonly env: Env
  private readonly repositories: Repositories
  private readonly sandboxFactory: (id: string) => StationSandbox
  constructor(
    env: Env,
    repositories: Repositories,
    sandboxFactory?: (id: string) => StationSandbox
  ) {
    this.env = env
    this.repositories = repositories
    this.sandboxFactory =
      sandboxFactory ?? ((id) => env.SANDBOX.getByName(`dispatch-${id}`))
  }
  open(input: OpenInput): DispatchSession {
    return new SandboxDispatchSession(
      this.env,
      this.repositories,
      this.sandboxFactory(crypto.randomUUID()),
      input
    )
  }
}

function baselineReport(commit: string, checks: CheckResult[]): BaselineReport {
  return {
    commit,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
      outputTail: `${check.stdout ?? ""}${check.stderr ?? ""}`.slice(-2000),
      outputTruncated: !!check.outputTruncated,
    })),
  }
}

/**
 * A read-only planning Sandbox. Baseline checks run with repository read
 * access and no model access. Before the Dispatcher starts, secrets and
 * history are removed and repository access is dropped, leaving only the
 * configured model reachable.
 */
class SandboxDispatchSession implements DispatchSession {
  readonly #env: Env
  readonly #repositories: Repositories
  readonly #sandbox: StationSandbox
  readonly #input: OpenInput
  #access: RepositoryAccess | undefined
  #session: string | null = null
  #agent: HarnessAgent | undefined
  #runs = 0
  constructor(
    env: Env,
    repositories: Repositories,
    sandbox: StationSandbox,
    input: OpenInput
  ) {
    this.#env = env
    this.#repositories = repositories
    this.#sandbox = sandbox
    this.#input = input
  }

  #workspace(phase: string): GitWorkspace {
    return {
      run: async (args, cwd, env) => {
        const started = Date.now()
        // Arguments and output can contain repository content; log only the operation.
        const result = commandResultSchema.parse(
          await this.#sandbox.run(args, cwd, env)
        )
        console.info("Dispatcher command completed", {
          phase,
          command: args[0],
          durationMs: Date.now() - started,
          exitCode: result.exitCode,
          outputTruncated: !!result.outputTruncated,
        })
        return result
      },
      close: () => this.#sandbox.close(),
    }
  }

  async prepare(): Promise<BaselineReport | null> {
    const { repository, checkBaseline, model } = this.#input
    gatewayConfig(this.#env, model)
    const validation = validationCommandsSchema.parse(this.#input.validation)
    this.#access = await this.#repositories.access(repository.repoId, "read")
    await this.#sandbox.configure({
      repositories: [
        {
          remote: this.#access.remote,
          token: this.#access.token,
          scope: "read",
        },
      ],
      allowModel: false,
    })
    await checkoutPlanningBaseline(
      this.#workspace("checkout"),
      this.#access,
      repository.commit
    )
    const baseline = checkBaseline
      ? baselineReport(
          repository.commit,
          await runProjectChecks(
            this.#workspace("baseline"),
            validation,
            planningDirectory
          )
        )
      : null
    await sealPlanningWorkspace(this.#workspace("seal"))
    // Exploration needs no repository access; only the configured model is reachable.
    await this.#sandbox.configure({ repositories: [], allowModel: true, model })
    const access = this.#access
    this.#access = undefined
    await this.#repositories.revoke(access)
    return baseline
  }

  async start(system: string, message: string): Promise<string> {
    this.#agent = dispatcherHarnessAgent(system)
    const prepared = await prepareHarness(
      this.#env,
      this.#sandbox,
      this.#workspace("preflight"),
      {
        model: this.#input.model,
        agent: this.#agent,
        directory: planningDirectory,
        assignment: message,
      }
    )
    await this.#sandbox.write(
      "/workspace/harness-events.mjs",
      harnessEventFilterScript
    )
    return this.#harness(prepared, startTimeoutMs)
  }

  async resume(message: string): Promise<string> {
    if (!this.#session || !this.#agent)
      throw new Error("Dispatcher session was not recorded")
    return this.#harness(
      {
        command: opencodeRunCommand(
          this.#agent.name,
          this.#input.model,
          message,
          this.#session
        ),
        env: { ...opencodeEnvironment },
      },
      resumeTimeoutMs
    )
  }

  /** Raw events stay outside the checkout; only the filtered outcome returns. */
  async #harness(
    { command, env }: PreparedHarness,
    timeoutMs: number
  ): Promise<string> {
    const events = `/workspace/harness-${++this.#runs}.jsonl`
    const started = Date.now()
    const harness = commandResultSchema.parse(
      await this.#sandbox.run(
        ["bash", "-c", 'exec "$@" > "$0"', events, ...command],
        planningDirectory,
        env,
        timeoutMs
      )
    )
    const filtered = commandResultSchema.parse(
      await this.#sandbox.run(
        ["node", "/workspace/harness-events.mjs", events],
        "/workspace"
      )
    )
    const output: CommandResult = {
      exitCode: harness.exitCode,
      stdout: filtered.stdout,
      stderr: harness.stderr,
      outputTruncated: !!filtered.outputTruncated,
    }
    console.info("Dispatcher harness completed", {
      run: this.#runs,
      durationMs: Date.now() - started,
      exitCode: harness.exitCode,
      tools: harnessToolCounts(output),
    })
    if (filtered.exitCode !== 0)
      throw new Error("Dispatcher harness output could not be read")
    this.#session ??= harnessSessionId(output)
    const outcome = harnessOutcome(output)
    if (outcome.error) throw new Error(outcome.error)
    return outcome.summary ?? ""
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.#sandbox.close(),
      ...(this.#access ? [this.#repositories.revoke(this.#access)] : []),
    ])
    this.#access = undefined
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Dispatcher workspace cleanup failed")
  }
}
