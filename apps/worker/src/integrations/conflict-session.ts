import { catalogModel, type RoleExecution } from "@terminus/protocol"
import {
  conflictHarnessAgent,
  type ConflictSession,
  type ConflictSessionFactory,
  type TrialMerge,
} from "@terminus/agent-runtime"
import {
  checkoutTrialMerge,
  sealedDirectory,
  sealWorkspace,
  type ArtifactsRepositoryHost,
  type RepositoryAccess,
} from "@terminus/artifacts"
import { validationCommandsSchema } from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import { runProjectChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type OpenInput = Parameters<ConflictSessionFactory["open"]>[0] & {
  execution?: RoleExecution
}

/** Sandbox name for one investigation, so it can be cancelled by name. */
export function conflictSandboxName(id: string): string {
  return `conflict-${id}`
}

export class SandboxConflictSessions implements ConflictSessionFactory {
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
    this.env = env
    this.repositories = repositories
    this.execution = execution
    this.sandboxFactory =
      sandboxFactory ?? ((id) => env.SANDBOX.getByName(conflictSandboxName(id)))
  }
  open(input: OpenInput): ConflictSession {
    return new SandboxConflictSession(
      this.env,
      this.repositories,
      this.sandboxFactory(input.id),
      { ...input, execution: this.execution }
    )
  }
}

/**
 * A read-only investigation Sandbox. With read access to both Train
 * repositories and no model access, it merges the other Train into this one
 * and runs trusted checks on a clean result. Secrets and history are then
 * removed and repository access dropped before the Dispatcher's harness
 * starts with only its model reachable.
 */
class SandboxConflictSession implements ConflictSession {
  readonly #env: Env
  readonly #repositories: Repositories
  readonly #sandbox: StationSandbox
  readonly #input: OpenInput
  readonly #harness: HarnessSession
  #access: RepositoryAccess[] = []
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
      label: conflictSandboxName(input.id),
      model: input.model,
      execution: input.execution,
      directory: sealedDirectory,
      startTimeoutMs: 15 * 60_000,
      resumeTimeoutMs: 5 * 60_000,
      onActivity: input.onActivity ?? (() => {}),
    })
  }

  #workspace(phase: string) {
    return loggedWorkspace(this.#sandbox, "Dispatcher", phase)
  }

  async prepare(): Promise<{
    trialMerge: TrialMerge
    checks: { name: string; status: string; outputTail?: string }[]
  }> {
    const { repositories, model } = this.#input
    gatewayConfig(this.#env, model)
    const validation = validationCommandsSchema.parse(this.#input.validation)
    this.#input.onActivity?.({ kind: "phase", phase: "preparing_workspace" })
    const train = await this.#repositories.access(
      repositories.train.repoId,
      "read"
    )
    this.#access.push(train)
    const other = await this.#repositories.access(
      repositories.other.repoId,
      "read"
    )
    this.#access.push(other)
    this.#input.onActivity?.({ kind: "phase", phase: "waiting_for_sandbox" })
    await this.#sandbox.configure({
      repositories: [train, other].map((access) => ({
        remote: access.remote,
        token: access.token,
        scope: "read" as const,
      })),
      allowModel: false,
    })
    this.#input.onActivity?.({ kind: "phase", phase: "checking_out" })
    const trialMerge = await checkoutTrialMerge(
      this.#workspace("trial merge"),
      { access: train, commit: repositories.train.commit },
      { access: other, commit: repositories.other.commit }
    )
    // Conflict markers would fail every check, so checks only run on a clean merge.
    let checks: { name: string; status: string; outputTail?: string }[] = []
    if (trialMerge.clean && validation.length) {
      this.#input.onActivity?.({ kind: "phase", phase: "checking_baseline" })
      checks = (
        await runProjectChecks(
          this.#workspace("merged checks"),
          validation,
          sealedDirectory
        )
      ).map((check) => ({
        name: check.name,
        status: check.status,
        outputTail: `${check.stdout ?? ""}${check.stderr ?? ""}`.slice(-2_000),
      }))
    }
    this.#input.onActivity?.({ kind: "phase", phase: "sealing_workspace" })
    await sealWorkspace(this.#workspace("seal"))
    await this.#sandbox.configure({
      repositories: [],
      allowModel: true,
      model,
      ...(catalogModel(model).provider === "workers-ai"
        ? {}
        : { provider: catalogModel(model).provider }),
    })
    await this.#revoke()
    return { trialMerge, checks }
  }

  start(system: string, message: string): Promise<string> {
    this.#input.onActivity?.({ kind: "phase", phase: "starting_agent" })
    return this.#harness.start(conflictHarnessAgent(system), message)
  }

  resume(message: string): Promise<string> {
    return this.#harness.resume(message)
  }

  async #revoke(): Promise<void> {
    const access = this.#access
    this.#access = []
    await Promise.all(access.map((item) => this.#repositories.revoke(item)))
  }

  async close(): Promise<void> {
    this.#input.onActivity?.({ kind: "phase", phase: "closing_workspace" })
    const results = await Promise.allSettled([
      this.#sandbox.close(),
      this.#revoke(),
    ])
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Dispatcher investigation cleanup failed")
  }
}
