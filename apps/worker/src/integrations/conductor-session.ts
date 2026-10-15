import {
  commandResultSchema,
  type RoleExecution,
  type ValidationCommand,
} from "@terminus/protocol"
import {
  conductorHarnessAgent,
  conductorReviewDirectory,
  type ConductorSession,
  type ConductorSessionFactory,
  type ReviewPreparation,
} from "@terminus/agent-runtime"
import {
  changedSinceSeal,
  checkoutSealedWorkspace,
  sealedDirectory,
  sealWorkspace,
  type ArtifactsRepositoryHost,
  type RepositoryAccess,
} from "@terminus/artifacts"
import { gatewayConfig, modelGrant } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import { runInstalledChecks } from "./project-checks"
import type { StationSandbox } from "./station-runner"
import { reviewStressStation } from "./scripted-stress"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type FactoryInput = Parameters<ConductorSessionFactory["open"]>[0]
type OpenInput = FactoryInput & {
  execution?: RoleExecution
  scripted?: boolean
}

export class SandboxConductorSessions implements ConductorSessionFactory {
  private readonly env: Env
  private readonly repositories: Repositories
  private readonly sandboxFactory: (id: string) => StationSandbox
  private readonly execution?: RoleExecution
  private readonly scripted: boolean
  constructor(
    env: Env,
    repositories: Repositories,
    sandboxFactory?: (id: string) => StationSandbox,
    execution?: RoleExecution,
    scripted = false
  ) {
    this.scripted = scripted
    this.execution = execution
    this.env = env
    this.repositories = repositories
    this.sandboxFactory =
      sandboxFactory ?? ((id) => env.SANDBOX.getByName(`conductor-${id}`))
  }
  open(input: OpenInput): ConductorSession {
    const id = crypto.randomUUID()
    return new SandboxConductorSession(
      this.env,
      this.repositories,
      this.sandboxFactory(id),
      {
        ...input,
        execution: this.execution,
        scripted: this.scripted,
      }
    )
  }
}

/**
 * A disposable review Sandbox for one candidate commit. Dependencies install
 * with read access to the Station repository and no model access. Secrets and
 * history are then removed and repository access is dropped; requested
 * validation runs next, with neither. Only then is the configured model made
 * reachable. The Conductor may run the app, but no Sandbox it uses can write
 * to any repository.
 */
class SandboxConductorSession implements ConductorSession {
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
      role: "Conductor",
      model: input.model,
      execution: input.execution,
      directory: sealedDirectory,
      startTimeoutMs: 20 * 60_000,
      resumeTimeoutMs: 5 * 60_000,
    })
  }

  #workspace(phase: string) {
    return loggedWorkspace(this.#sandbox, "Conductor", phase)
  }

  async prepare(validation?: ValidationCommand[]): Promise<ReviewPreparation> {
    const { candidate, model } = this.#input
    if (!this.#input.scripted) gatewayConfig(this.#env, model)
    this.#access = await this.#repositories.access(candidate.repoId, "read")
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
      candidate.commit
    )
    const installed = commandResultSchema.parse(
      await this.#sandbox.installDependencies(sealedDirectory)
    )
    if (this.#input.scripted && installed.exitCode !== 0)
      throw new Error("Stress review dependency installation failed")
    // Install scripts are repository code, so the checkout is fingerprinted after them.
    await sealWorkspace(this.#workspace("seal"), { fingerprint: true })
    await this.#sandbox.configure({ repositories: [], allowModel: false })
    const access = this.#access
    this.#access = undefined
    await this.#repositories.revoke(access)
    const install = {
      exitCode: installed.exitCode,
      outputTail: `${installed.stdout}${installed.stderr}`.slice(-2000),
    }
    if (!validation) return { install }
    const checks = await runInstalledChecks(
      (name) => this.#workspace(`validation:${name}`),
      validation,
      sealedDirectory
    )
    await this.#assertUnchanged("Project validation")
    return { install, evidence: { checks } }
  }

  async start(
    system: string,
    message: string,
    material: Record<string, string>
  ): Promise<string> {
    const { model } = this.#input
    const created = await this.#workspace("material").run([
      "mkdir",
      "-p",
      conductorReviewDirectory,
    ])
    if (created.exitCode !== 0)
      throw new Error("Could not create the Conductor review directory")
    for (const [name, contents] of Object.entries(material))
      await this.#sandbox.write(`${conductorReviewDirectory}/${name}`, contents)
    if (this.#input.scripted) {
      const text = await reviewStressStation(
        this.#workspace("scripted review"),
        material,
        sealedDirectory
      )
      await this.#assertUnchanged("Scripted Conductor")
      return text
    }
    await this.#sandbox.configure({
      repositories: [],
      allowModel: true,
      ...modelGrant(model, this.#input.execution),
    })
    const text = await this.#harness.start(
      conductorHarnessAgent(system),
      message
    )
    await this.#assertUnchanged("The Conductor")
    return text
  }

  async resume(message: string): Promise<string> {
    if (this.#input.scripted)
      throw new Error("Scripted verdicts cannot be corrected by a model")
    const text = await this.#harness.resume(message)
    await this.#assertUnchanged("The Conductor")
    return text
  }

  /** A verdict counts only if it describes the candidate commit as checked out. */
  async #assertUnchanged(actor: string): Promise<void> {
    const changed = await changedSinceSeal(this.#workspace("verify"))
    if (changed.count)
      throw new Error(
        `${actor} changed ${changed.count} tracked file(s) in the candidate checkout (${changed.paths.join(", ")}), so the review no longer describes the candidate`
      )
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.#sandbox.close(),
      ...(this.#access ? [this.#repositories.revoke(this.#access)] : []),
    ])
    this.#access = undefined
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Conductor workspace cleanup failed")
  }
}
