import {
  scriptedStressAgent,
  stressTask,
  type RoleExecution,
} from "@terminus/protocol"
import {
  harnessResult,
  logHarnessTimeline,
  executionConfig,
  agentProvenance,
  stationHarnessAgent,
  stationMessage,
  type StationRunner,
  type StationRunInput,
  type StationRunResult,
} from "@terminus/agent-runtime"
import {
  StationGit,
  stationDirectory,
  type ArtifactsRepositoryHost,
  type GitWorkspace,
} from "@terminus/artifacts"
import type { AgentConfig } from "@terminus/domain"
import {
  commandResultSchema,
  errorKind,
  PerfPhases,
  validationCommandsSchema,
} from "@terminus/protocol"
import type { NetworkStore } from "./network-store"
import { gatewayConfig, modelGrant } from "./execution-config"
import { prepareHarness, runPreparedHarness } from "./harness"
import { runInstalledChecks } from "./project-checks"
import { runStressStation } from "./scripted-stress"

const repoDirectory = stationDirectory

export interface StationSandbox {
  configure(network: import("@terminus/protocol").SandboxNetwork): Promise<void>
  run(
    command: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number
  ): Promise<unknown>
  /** Streaming command output; harness callers supply an in-Sandbox activity filter. */
  runStream?(
    command: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number,
    options?: import("./execution-sandbox").StreamOptions
  ): Promise<ReadableStream<Uint8Array>>
  /** Installs dependencies in `cwd` with the shared npm cache. */
  installDependencies(cwd: string): Promise<unknown>
  write(path: string, contents: string): Promise<void>
  close(): Promise<void>
}

export class SandboxStationRunner implements StationRunner {
  readonly config: AgentConfig
  readonly #env: Env
  readonly #repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">
  readonly #store: NetworkStore
  readonly #sandbox: (runId: string) => StationSandbox
  readonly #validate: boolean
  readonly #scripted: boolean

  private readonly execution: RoleExecution
  /**
   * `validate` collects evidence in the Station Sandbox. Leave it off when the
   * Conductor collects evidence in its own clean checkout: a check run where
   * the Station Agent had a shell is not independent of that agent.
   */
  constructor(
    env: Env,
    model: string,
    repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">,
    store: NetworkStore,
    sandbox?: (runId: string) => StationSandbox,
    execution: RoleExecution = executionConfig(model),
    validate = false,
    scripted = false
  ) {
    this.#scripted = scripted
    this.#validate = validate
    this.execution = execution
    this.#env = env
    this.#repositories = repositories
    this.#store = store
    this.#sandbox =
      sandbox ?? ((runId) => env.SANDBOX.getByName(`station-${runId}`))
    this.config = scripted
      ? scriptedStressAgent
      : agentProvenance(this.execution)
  }

  async run(input: StationRunInput): Promise<StationRunResult> {
    if (this.#scripted) stressTask(input.manifest)
    else if (input.manifest.goal.startsWith("Pipeline stress ten-trains-v1 "))
      throw new Error(
        "Use the explicit stress-test command before resuming this fixture"
      )
    // TEMPORARY benchmark instrumentation.
    const phases = new PerfPhases("station.run", {
      runId: input.runId,
      stationId: input.stationId,
      revision: !!input.feedback,
    })
    phases.enter("checkpoint lookup")
    const checkpoint = await this.#store.agentCheckpoint(input, this.config)
    if (checkpoint?.published) {
      phases.finish({ ok: true, reused: "published checkpoint" })
      return checkpoint.result
    }
    if (!this.#scripted) gatewayConfig(this.#env, this.config.model)
    const validation = validationCommandsSchema.parse(input.validation)
    for (const name of input.manifest.expectedEvidence) {
      if (!validation.some((check) => check.name === name))
        throw new Error(
          `Project has no validation command for required evidence: ${name}`
        )
    }
    const station = await this.#store.station(input.stationId)
    if (!station) throw new Error("Unknown Station")
    phases.enter("access")
    const access = await this.#repositories.access(
      input.workspace.repoId,
      "write"
    )
    const sandbox = this.#sandbox(input.runId)
    let phase = "checkout"
    const enter = (next: string) => {
      phase = next
      phases.enter(next)
    }
    const workspace: GitWorkspace = {
      run: async (args, cwd, env) => {
        const started = Date.now()
        const context = {
          runId: input.runId,
          stationId: input.stationId,
          phase,
          command: args[0],
        }
        // Arguments, environment, and process output can contain credentials
        // or agent context. Log only the operation and independently observed status.
        console.info("Station command started", context)
        try {
          const result = commandResultSchema.parse(
            await sandbox.run(args, cwd, env)
          )
          console.info("Station command completed", {
            ...context,
            durationMs: Date.now() - started,
            exitCode: result.exitCode,
            outputTruncated: !!result.outputTruncated,
          })
          return result
        } catch (error) {
          console.error("Station command failed", {
            ...context,
            durationMs: Date.now() - started,
            reference:
              error instanceof Error
                ? error.message.match(
                    /internal error; reference = ([a-z0-9]+)/
                  )?.[1]
                : undefined,
          })
          throw error
        }
      },
      close: () => sandbox.close(),
    }
    let saved = false
    let unpublishedCandidate = !!checkpoint
    try {
      phases.enter("configure (container start)")
      await sandbox.configure({
        repositories: [
          { remote: access.remote, token: access.token, scope: "write" },
        ],
        allowModel: !this.#scripted,
        ...(this.#scripted
          ? {}
          : modelGrant(this.config.model, this.execution)),
      })
      // Each run starts from durable Station history, including prior revisions.
      const repository = new StationGit(
        workspace,
        access,
        input.workspace.baseCommit
      )
      if (checkpoint) {
        enter("recovery")
        if (!checkpoint.result.ok)
          throw new Error("Station checkpoint does not contain a candidate")
        const proposal = checkpoint.result.proposal
        await repository.recover(proposal.headCommit)
        const snapshot = await repository.snapshot(proposal.headCommit)
        if (
          snapshot.diff !== proposal.diff ||
          JSON.stringify(snapshot.changedPaths) !==
            JSON.stringify(proposal.changedPaths)
        )
          throw new Error(
            "Recovered candidate differs from its evidence checkpoint"
          )
        await repository.publish(proposal.headCommit)
        await this.#store.publishAgentRun(input, this.config)
        saved = true
        return checkpoint.result
      }
      enter("checkout")
      await repository.prepare()
      await sandbox.write(
        "/workspace/manifest.json",
        JSON.stringify(input.manifest, null, 2)
      )
      enter("dependencies")
      const installed = commandResultSchema.parse(
        await sandbox.installDependencies(repoDirectory)
      )
      if (installed.exitCode !== 0)
        throw new Error("Project dependency installation failed")
      let summary: string | null | undefined
      if (this.#scripted) {
        enter("scripted edit")
        summary = await runStressStation(
          workspace,
          input.manifest,
          repoDirectory
        )
      } else {
        // Install scripts are repository code, so the harness is prepared after them.
        enter("preflight")
        const prepared = await prepareHarness(this.#env, sandbox, workspace, {
          model: this.config.model,
          execution: this.execution,
          agent: stationHarnessAgent,
          directory: repoDirectory,
          assignment: stationMessage(input),
        })
        enter("harness")
        const harness = await runPreparedHarness(
          {
            // RPC stub methods are not enumerable; forward calls instead of spreading the stub.
            write: (path, contents) => sandbox.write(path, contents),
            run: workspace.run,
          },
          prepared,
          repoDirectory,
          undefined,
          undefined,
          {
            role: "Station",
            sandbox: `station-${input.runId}`,
            runId: input.runId,
            kind: "start",
          }
        )
        const outcome = harnessResult(prepared.harness, harness)
        logHarnessTimeline(
          {
            role: "Station",
            sandbox: `station-${input.runId}`,
            runId: input.runId,
            kind: "start",
            error: outcome.error?.slice(0, 300),
            finalChars: outcome.summary?.length,
          },
          harness,
          phases.currentMs()
        )
        if (outcome.error) throw new Error(outcome.error)
        summary = outcome.summary
      }

      enter("candidate")
      const headCommit = await repository.candidate(
        `Station ${input.stationId}: ${input.manifest.goal}`
      )
      // Without validation here, the evidence stays empty until review.
      const checks = this.#validate
        ? await runInstalledChecks(
            (name) => {
              enter(`validation:${name}`)
              return workspace
            },
            validation,
            repoDirectory
          )
        : []
      enter("evidence")
      const { changedPaths, diff } = await repository.snapshot(headCommit)
      const result: StationRunResult = {
        ok: true,
        proposal: {
          headCommit,
          changedPaths,
          diff,
          evidence: { checks },
          agent: this.config,
          agentSummary: summary?.slice(-8000) ?? null,
        },
      }
      // Checkpoint before pushing so a retry cannot repeat a paid agent call.
      // Preserve local Git objects even if the D1 write's acknowledgement is lost.
      unpublishedCandidate = true
      enter("record checkpoint")
      await this.#store.recordAgentRun(
        station.networkId,
        input,
        this.config,
        result
      )
      enter("publish")
      await repository.publish(headCommit)
      await this.#store.publishAgentRun(input, this.config)
      saved = true
      phases.enter("close")
      return result
    } catch (error) {
      phases.finish({
        ok: false,
        error: errorKind(error),
      })
      // The Engineer triages failed runs, so report where this one stopped.
      throw new StationExecutionError(
        phase,
        `Station run failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    } finally {
      // Only a checkpointed, unpublished candidate needs its local Git objects
      // for recovery. Earlier failures must release capacity before another run.
      try {
        if (saved || !unpublishedCandidate) {
          try {
            await workspace.close()
          } catch {
            // Preserve the original run outcome; explicit cleanup can retry.
            console.error("Station Sandbox cleanup failed", {
              runId: input.runId,
              stationId: input.stationId,
            })
          }
        }
      } finally {
        await this.#repositories.revoke(access)
        if (saved) phases.finish({ ok: true })
      }
    }
  }
}

/** Trusted orchestration phase; never inferred from agent text. */
export class StationExecutionError extends Error {
  readonly phase: string
  constructor(phase: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.phase = phase
  }
}
