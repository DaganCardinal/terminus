import { type PlanDraft, type RoleExecution } from "@terminus/protocol"
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
import { DispatchDraftStore } from "./dispatch-draft-store"
import { gatewayConfig, modelGrant } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import { runProjectChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type FactoryInput = Parameters<DispatchSessionFactory["open"]>[0]
type OpenInput = FactoryInput & {
  execution?: RoleExecution
  /** The Sandbox name, for operational logs. */
  label?: string
}
/** The plan whose draft the plan tools write is always known in a session. */
type SessionInput = OpenInput & { planId: string; persistent: boolean }

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
    const id = input.planId ?? crypto.randomUUID()
    return new SandboxDispatchSession(
      this.env,
      this.repositories,
      this.sandboxFactory(id),
      {
        ...input,
        planId: id,
        persistent: input.planId !== undefined,
        execution: this.execution,
        label: `dispatch-${id}`,
      }
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
  readonly #input: SessionInput
  readonly #harness: HarnessSession
  readonly #drafts: DispatchDraftStore
  #access: RepositoryAccess | undefined
  #usedSandbox = false
  constructor(
    env: Env,
    repositories: Repositories,
    sandbox: StationSandbox,
    input: SessionInput
  ) {
    this.#env = env
    this.#repositories = repositories
    this.#sandbox = sandbox
    this.#input = input
    this.#drafts = new DispatchDraftStore(env.DB)
    this.#harness = new HarnessSession(env, sandbox, {
      role: "Dispatcher",
      model: input.model,
      execution: input.execution,
      directory: sealedDirectory,
      startTimeoutMs: 15 * 60_000,
      resumeTimeoutMs: 5 * 60_000,
      // Always observed: the live runner also stops the harness once a
      // proposal is accepted, saving the model's closing round trip.
      onActivity: input.onActivity ?? (() => {}),
    })
  }

  #workspace(phase: string) {
    return loggedWorkspace(this.#sandbox, "Dispatcher", phase)
  }

  #context(): string {
    return JSON.stringify({
      version: 1,
      repository: this.#input.repository,
      checkBaseline: this.#input.checkBaseline,
      validation: validationCommandsSchema.parse(this.#input.validation),
      model: this.#input.model,
      execution: this.#input.execution ?? null,
    })
  }

  async restore() {
    if (!this.#input.persistent) return null
    const saved = await this.#drafts.restore(
      this.#input.planId,
      this.#context()
    )
    // Baseline evidence must agree with the exact commit and requested option.
    if (
      saved &&
      (this.#input.checkBaseline
        ? saved.baseline?.commit !== this.#input.repository.commit
        : saved.baseline !== null)
    )
      return null
    return saved
  }

  async prepare(): Promise<BaselineReport | null> {
    const { repository, checkBaseline, model } = this.#input
    gatewayConfig(this.#env, model)
    const validation = validationCommandsSchema.parse(this.#input.validation)
    const saved = await this.restore()
    this.#input.onActivity?.({ kind: "phase", phase: "preparing_workspace" })
    // A harness outlives a lost stream so it can be followed again. An earlier
    // attempt whose Worker stopped before closing may have left one running in
    // this plan's Sandbox, so never grant repository access beside it.
    if (this.#input.persistent) await this.#sandbox.close()
    this.#access = await this.#repositories.access(repository.repoId, "read")
    this.#input.onActivity?.({ kind: "phase", phase: "waiting_for_sandbox" })
    this.#usedSandbox = true
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
    this.#input.onActivity?.({ kind: "phase", phase: "checking_out" })
    await checkoutSealedWorkspace(
      this.#workspace("checkout"),
      this.#access,
      repository.commit
    )
    if (checkBaseline && !saved)
      this.#input.onActivity?.({ kind: "phase", phase: "checking_baseline" })
    const baseline = saved
      ? saved.baseline
      : checkBaseline
        ? baselineReport(
            repository.commit,
            await runProjectChecks(
              this.#workspace("baseline"),
              validation,
              sealedDirectory
            )
          )
        : null
    if (this.#input.persistent)
      await this.#drafts.begin(this.#input.planId, this.#context(), baseline)
    this.#input.onActivity?.({ kind: "phase", phase: "sealing_workspace" })
    await sealWorkspace(this.#workspace("seal"))
    // Exploration needs no repository access; only the configured model and
    // the plan tools, which answer inside the outbound handler, are reachable.
    await this.#sandbox.configure({
      repositories: [],
      allowModel: true,
      ...modelGrant(model, this.#input.execution),
      proposalCheck: {
        planId: this.#input.planId,
        network: this.#input.network,
        baseline,
      },
    })
    const access = this.#access
    this.#access = undefined
    await this.#repositories.revoke(access)
    return baseline
  }

  start(system: string, message: string): Promise<string> {
    this.#input.onActivity?.({ kind: "phase", phase: "starting_agent" })
    return this.#harness.start(dispatcherHarnessAgent(system), message)
  }

  resume(message: string): Promise<string> {
    return this.#harness.resume(message)
  }

  draft(): Promise<PlanDraft> {
    return this.#drafts.read(this.#input.planId)
  }

  async close(): Promise<void> {
    // Restoring a complete draft never starts or touches its named Sandbox.
    if (!this.#usedSandbox && !this.#access) return
    this.#input.onActivity?.({ kind: "phase", phase: "closing_workspace" })
    const results = await Promise.allSettled([
      this.#sandbox.close(),
      ...(this.#access ? [this.#repositories.revoke(this.#access)] : []),
    ])
    this.#access = undefined
    if (results.some((result) => result.status === "rejected")) {
      // The planner keeps its outcome, so this log is the only record.
      console.error("Dispatcher workspace cleanup failed", {
        sandbox: this.#input.label,
      })
      throw new Error("Dispatcher workspace cleanup failed")
    }
  }
}
