import { catalogModel, type RoleExecution } from "@terminus/protocol"
import {
  dispatcherHarnessAgent,
  type DispatchSession,
  type DispatchSessionFactory,
} from "@terminus/agent-runtime"
import {
  checkoutSealedWorkspace,
  sealedDirectory,
  sealWorkspace,
  type ArtifactsRepositoryHost,
  type RepositoryAccess,
} from "@terminus/artifacts"
import type { BaselineReport, CheckResult } from "@terminus/domain"
import { validationCommandsSchema } from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import { runProjectChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type FactoryInput = Parameters<DispatchSessionFactory["open"]>[0]
type OpenInput = FactoryInput & { execution?: RoleExecution }

export class SandboxDispatchSessions implements DispatchSessionFactory {
  private readonly env: Env
  private readonly repositories: Repositories
  private readonly sandboxFactory: (id: string) => StationSandbox
  private readonly execution?: RoleExecution
  constructor(
    env: Env,
    repositories: Repositories,
    sandboxFactory?: (id: string) => StationSandbox,
    execution?: RoleExecution
  ) {
    this.execution = execution
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
      { ...input, execution: this.execution }
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
  readonly #harness: HarnessSession
  #access: RepositoryAccess | undefined
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
    this.#harness = new HarnessSession(env, sandbox, {
      role: "Dispatcher",
      model: input.model,
      execution: input.execution,
      directory: sealedDirectory,
      startTimeoutMs: 15 * 60_000,
      resumeTimeoutMs: 5 * 60_000,
    })
  }

  #workspace(phase: string) {
    return loggedWorkspace(this.#sandbox, "Dispatcher", phase)
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
    await checkoutSealedWorkspace(
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
            sealedDirectory
          )
        )
      : null
    await sealWorkspace(this.#workspace("seal"))
    // Exploration needs no repository access; only the configured model is reachable.
    await this.#sandbox.configure({
      repositories: [],
      allowModel: true,
      model,
      ...(catalogModel(model).provider === "workers-ai"
        ? {}
        : { provider: catalogModel(model).provider }),
    })
    const access = this.#access
    this.#access = undefined
    await this.#repositories.revoke(access)
    return baseline
  }

  start(system: string, message: string): Promise<string> {
    return this.#harness.start(dispatcherHarnessAgent(system), message)
  }

  resume(message: string): Promise<string> {
    return this.#harness.resume(message)
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
