import { catalogModel, type RoleExecution } from "@terminus/protocol"
import {
  harnessResult,
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
import type { AgentConfig, CheckResult } from "@terminus/domain"
import {
  commandResultSchema,
  validationCommandsSchema,
} from "@terminus/protocol"
import type { NetworkStore } from "./network-store"
import { gatewayConfig } from "./execution-config"
import { prepareHarness, runPreparedHarness } from "./harness"

const repoDirectory = stationDirectory

export interface StationSandbox {
  configure(network: import("@terminus/protocol").SandboxNetwork): Promise<void>
  run(
    command: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number
  ): Promise<unknown>
  write(path: string, contents: string): Promise<void>
  close(): Promise<void>
}

export class SandboxStationRunner implements StationRunner {
  readonly config: AgentConfig
  readonly #env: Env
  readonly #repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">
  readonly #store: NetworkStore
  readonly #sandbox: (runId: string) => StationSandbox

  private readonly execution: RoleExecution
  constructor(
    env: Env,
    model: string,
    repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">,
    store: NetworkStore,
    sandbox?: (runId: string) => StationSandbox,
    execution: RoleExecution = executionConfig(model)
  ) {
    this.execution = execution
    this.#env = env
    this.#repositories = repositories
    this.#store = store
    this.#sandbox =
      sandbox ?? ((runId) => env.SANDBOX.getByName(`station-${runId}`))
    this.config = agentProvenance(this.execution)
  }

  async run(input: StationRunInput): Promise<StationRunResult> {
    const checkpoint = await this.#store.agentCheckpoint(input, this.config)
    if (checkpoint?.published) return checkpoint.result
    const config = gatewayConfig(this.#env, this.config.model)
    const validation = validationCommandsSchema.parse(input.validation)
    for (const name of input.manifest.expectedEvidence) {
      if (!validation.some((check) => check.name === name))
        throw new Error(
          `Project has no validation command for required evidence: ${name}`
        )
    }
    const station = await this.#store.station(input.stationId)
    if (!station) throw new Error("Unknown Station")
    const access = await this.#repositories.access(
      input.workspace.repoId,
      "write"
    )
    const sandbox = this.#sandbox(input.runId)
    let phase = "checkout"
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
    try {
      await sandbox.configure({
        repositories: [
          { remote: access.remote, token: access.token, scope: "write" },
        ],
        allowModel: true,
        model: this.config.model,
        ...(catalogModel(this.config.model).provider === "workers-ai"
          ? {}
          : { provider: catalogModel(this.config.model).provider }),
      })
      // Each run starts from durable Station history, including prior revisions.
      const repository = new StationGit(
        workspace,
        access,
        input.workspace.baseCommit
      )
      if (checkpoint) {
        phase = "recovery"
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
      await repository.prepare()
      await sandbox.write(
        "/workspace/manifest.json",
        JSON.stringify(input.manifest, null, 2)
      )
      phase = "dependencies"
      const installed = commandResultSchema.parse(
        await workspace.run(
          ["npm", "ci", "--no-audit", "--no-fund"],
          repoDirectory
        )
      )
      if (installed.exitCode !== 0)
        throw new Error("Project dependency installation failed")
      // Install scripts are repository code, so the harness is prepared after them.
      phase = "preflight"
      const prepared = await prepareHarness(this.#env, sandbox, workspace, {
        model: config.model,
        execution: this.execution,
        agent: stationHarnessAgent,
        directory: repoDirectory,
        assignment: stationMessage(input),
      })
      phase = "harness"
      const harness = await runPreparedHarness(
        { ...sandbox, run: workspace.run.bind(workspace) },
        prepared,
        repoDirectory
      )
      const outcome = harnessResult(prepared.harness, harness)
      if (outcome.error) throw new Error(outcome.error)

      phase = "candidate"
      const headCommit = await repository.candidate(
        `Station ${input.stationId}: ${input.manifest.goal}`
      )
      const checks: CheckResult[] = []
      for (const check of validation) {
        phase = `validation:${check.name}`
        const result = commandResultSchema.parse(
          await workspace.run(check.command, repoDirectory)
        )
        checks.push({
          name: check.name,
          command: check.command,
          required: true,
          status: result.exitCode === 0 ? "passed" : "failed",
          exitCode: result.exitCode,
          stdout: result.stdout.slice(-8000),
          stderr: result.stderr.slice(-8000),
          outputTruncated:
            !!result.outputTruncated ||
            result.stdout.length > 8000 ||
            result.stderr.length > 8000,
        })
      }
      phase = "evidence"
      const { changedPaths, diff } = await repository.snapshot(headCommit)
      const result: StationRunResult = {
        ok: true,
        proposal: {
          headCommit,
          changedPaths,
          diff,
          evidence: { checks },
          agent: this.config,
          agentSummary: outcome.summary?.slice(-8000) ?? null,
        },
      }
      // Checkpoint before pushing so a retry cannot repeat a paid agent call.
      await this.#store.recordAgentRun(
        station.networkId,
        input,
        this.config,
        result
      )
      phase = "publish"
      await repository.publish(headCommit)
      await this.#store.publishAgentRun(input, this.config)
      saved = true
      return result
    } finally {
      // Leave an interrupted workspace available until the Workflow retries.
      try {
        if (saved) await workspace.close()
      } finally {
        await this.#repositories.revoke(access)
      }
    }
  }
}
