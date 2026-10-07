import { catalogModel, type RoleExecution } from "@terminus/protocol"
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
import { gatewayConfig } from "./execution-config"
import { HarnessSession, loggedWorkspace } from "./harness"
import type { StationSandbox } from "./station-runner"

type Repositories = Pick<ArtifactsRepositoryHost, "access" | "revoke">
type FactoryInput = Parameters<ConductorSessionFactory["open"]>[0]
type OpenInput = FactoryInput & { execution?: RoleExecution }

export class SandboxConductorSessions implements ConductorSessionFactory {
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
      sandboxFactory ?? ((id) => env.SANDBOX.getByName(`conductor-${id}`))
  }
  open(input: OpenInput): ConductorSession {
    return new SandboxConductorSession(
      this.env,
      this.repositories,
      this.sandboxFactory(crypto.randomUUID()),
      { ...input, execution: this.execution }
    )
  }
}

/**
 * A disposable review Sandbox for one candidate commit. Dependencies install
 * with read access to the Station repository and no model access. Before the
 * Conductor starts, secrets and history are removed and repository access is
 * dropped, leaving only the configured model reachable. The Conductor may run
 * the app, but no Sandbox it uses can write to any repository.
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

  async prepare(material: Record<string, string>): Promise<ReviewPreparation> {
    const { candidate, model } = this.#input
    gatewayConfig(this.#env, model)
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
    const installed = await this.#workspace("dependencies").run(
      ["npm", "ci", "--no-audit", "--no-fund"],
      sealedDirectory
    )
    const created = await this.#workspace("material").run([
      "mkdir",
      "-p",
      conductorReviewDirectory,
    ])
    if (created.exitCode !== 0)
      throw new Error("Could not create the Conductor review directory")
    for (const [name, contents] of Object.entries(material))
      await this.#sandbox.write(`${conductorReviewDirectory}/${name}`, contents)
    // Install scripts are repository code, so the checkout is fingerprinted after them.
    await sealWorkspace(this.#workspace("seal"), { fingerprint: true })
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
    return {
      install: {
        exitCode: installed.exitCode,
        outputTail: `${installed.stdout}${installed.stderr}`.slice(-2000),
      },
    }
  }

  async start(system: string, message: string): Promise<string> {
    const text = await this.#harness.start(
      conductorHarnessAgent(system),
      message
    )
    await this.#assertUnchanged()
    return text
  }

  async resume(message: string): Promise<string> {
    const text = await this.#harness.resume(message)
    await this.#assertUnchanged()
    return text
  }

  /** A verdict counts only if it describes the candidate commit as checked out. */
  async #assertUnchanged(): Promise<void> {
    const changed = await changedSinceSeal(this.#workspace("verify"))
    if (changed.count)
      throw new Error(
        `The Conductor changed ${changed.count} tracked file(s) in the candidate checkout (${changed.paths.join(", ")}), so its review no longer describes the candidate`
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
