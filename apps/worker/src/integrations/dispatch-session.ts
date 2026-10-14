import {
  catalogModel,
  type PlanDraft,
  type RoleExecution,
} from "@terminus/protocol"
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
import { PerfPhases, validationCommandsSchema } from "@terminus/protocol"
import { DispatchDraftStore } from "./dispatch-draft-store"
import { gatewayConfig } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import { runProjectChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type FactoryInput = Parameters<DispatchSessionFactory["open"]>[0]
type OpenInput = FactoryInput & {
  execution?: RoleExecution
  /** TEMPORARY benchmark instrumentation: the Sandbox name. */
  label?: string
}
/** The plan whose draft the plan tools write is always known in a session. */
type SessionInput = OpenInput & { planId: string }

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
  /** TEMPORARY benchmark instrumentation. */
  readonly #phases: PerfPhases
  #resumes = 0
  constructor(
    env: Env,
    repositories: Repositories,
    sandbox: StationSandbox,
    input: SessionInput
  ) {
    this.#phases = new PerfPhases("dispatcher.session", {
      sandbox: input.label,
      checkBaseline: input.checkBaseline,
    })
    this.#env = env
    this.#repositories = repositories
    this.#sandbox = sandbox
    this.#input = input
    this.#drafts = new DispatchDraftStore(env.DB)
    this.#harness = new HarnessSession(env, sandbox, {
      role: "Dispatcher",
      label: input.label,
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

  async prepare(): Promise<BaselineReport | null> {
    const { repository, checkBaseline, model } = this.#input
    gatewayConfig(this.#env, model)
    const validation = validationCommandsSchema.parse(this.#input.validation)
    this.#phases.enter("access")
    this.#input.onActivity?.({ kind: "phase", phase: "preparing_workspace" })
    this.#access = await this.#repositories.access(repository.repoId, "read")
    this.#phases.enter("configure (container start)")
    this.#input.onActivity?.({ kind: "phase", phase: "waiting_for_sandbox" })
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
    this.#phases.enter("checkout")
    this.#input.onActivity?.({ kind: "phase", phase: "checking_out" })
    await checkoutSealedWorkspace(
      this.#workspace("checkout"),
      this.#access,
      repository.commit
    )
    this.#phases.enter("baseline checks")
    if (checkBaseline)
      this.#input.onActivity?.({ kind: "phase", phase: "checking_baseline" })
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
    this.#phases.enter("seal")
    this.#input.onActivity?.({ kind: "phase", phase: "sealing_workspace" })
    await sealWorkspace(this.#workspace("seal"))
    this.#phases.enter("grant model")
    // A retried attempt starts its plan again.
    await this.#drafts.clear(this.#input.planId)
    // Exploration needs no repository access; only the configured model and
    // the plan tools, which answer inside the outbound handler, are reachable.
    await this.#sandbox.configure({
      repositories: [],
      allowModel: true,
      model,
      ...(catalogModel(model).provider === "workers-ai"
        ? {}
        : { provider: catalogModel(model).provider }),
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
    this.#phases.enter("harness start")
    this.#input.onActivity?.({ kind: "phase", phase: "starting_agent" })
    return this.#harness.start(dispatcherHarnessAgent(system), message)
  }

  resume(message: string): Promise<string> {
    this.#resumes++
    this.#phases.enter("harness resume (proposal correction)")
    return this.#harness.resume(message)
  }

  draft(): Promise<PlanDraft> {
    return this.#drafts.read(this.#input.planId)
  }

  async close(): Promise<void> {
    this.#phases.enter("close")
    this.#input.onActivity?.({ kind: "phase", phase: "closing_workspace" })
    const results = await Promise.allSettled([
      this.#sandbox.close(),
      ...(this.#access ? [this.#repositories.revoke(this.#access)] : []),
    ])
    this.#access = undefined
    this.#phases.finish({ resumes: this.#resumes })
    if (results.some((result) => result.status === "rejected")) {
      // The planner keeps its outcome, so this log is the only record.
      console.error("Dispatcher workspace cleanup failed", {
        sandbox: this.#input.label,
      })
      throw new Error("Dispatcher workspace cleanup failed")
    }
  }
}
