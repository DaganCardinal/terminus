import {
  harnessOutcome,
  technicianHarnessAgent,
  technicianMessage,
  type TechnicianRunner,
} from "@terminus/agent-runtime"
import {
  TechnicianGit,
  technicianDirectory,
  type ArtifactsRepositoryHost,
  type RepositoryAccess,
  type GitWorkspace,
} from "@terminus/artifacts"
import type { TechnicianRepair, RepairCandidate } from "@terminus/domain"
import { commandResultSchema } from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import { prepareHarness } from "./harness"
import type { StationSandbox } from "./station-runner"

export class SandboxTechnicianRunner implements TechnicianRunner {
  readonly config: { harness: string; model: string }
  private readonly env: Env
  private readonly repositories: Pick<
    ArtifactsRepositoryHost,
    "access" | "revoke"
  >
  private readonly sandboxFactory: (id: string) => StationSandbox
  constructor(
    env: Env,
    model: string,
    repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">,
    sandboxFactory?: (id: string) => StationSandbox
  ) {
    this.env = env
    this.repositories = repositories
    this.sandboxFactory =
      sandboxFactory ?? ((id) => env.SANDBOX.getByName(`technician-${id}`))
    this.config = { harness: "opencode@1.18.32", model }
  }
  async run(
    repair: TechnicianRepair,
    workspaceRepoId: string
  ): Promise<RepairCandidate> {
    if (
      this.config.model !== repair.agent.model ||
      this.config.harness !== repair.agent.harness
    )
      throw new Error("Technician configuration changed after dispatch")
    const config = gatewayConfig(this.env, this.config.model)
    const accesses: RepositoryAccess[] = []
    let sandbox: StationSandbox | undefined
    let cleanupFailed: boolean
    let result: RepairCandidate
    try {
      // Only the isolated repair repo is writable; accepted Train history is read-only.
      accesses.push(await this.repositories.access(workspaceRepoId, "write"))
      accesses.push(
        await this.repositories.access(repair.source.trainRepoId, "read")
      )
      sandbox = this.sandboxFactory(`${repair.id}-${crypto.randomUUID()}`)
      await sandbox.configure({
        repositories: accesses.map((access) => ({
          remote: access.remote,
          token: access.token,
          scope: access.scope,
        })),
        allowModel: true,
        model: this.config.model,
      })
      const workspace: GitWorkspace = {
        run: async (command, cwd, env) =>
          commandResultSchema.parse(await sandbox!.run(command, cwd, env)),
        close: () => sandbox!.close(),
      }
      const git = new TechnicianGit(
        workspace,
        accesses[0]!,
        accesses[1]!,
        repair
      )
      // A lost response after publication reuses durable candidate history.
      let headCommit = await git.prepare()
      let summary: string | null = null
      if (!headCommit) {
        await sandbox.write(
          "/workspace/repair.json",
          JSON.stringify(repair, null, 2)
        )
        const prepared = await prepareHarness(this.env, sandbox, workspace, {
          model: config.model,
          agent: technicianHarnessAgent(repair),
          directory: technicianDirectory,
          assignment: technicianMessage(repair),
        })
        const harness = await workspace.run(
          prepared.command,
          technicianDirectory,
          prepared.env
        )
        const outcome = harnessOutcome(harness)
        if (outcome.error) throw new Error(outcome.error)
        summary = outcome.summary?.slice(-8000) ?? null
        headCommit = await git.candidateCommit()
        await git.publish(headCommit)
      }
      const snapshot = await git.snapshot(headCommit)
      result = {
        workspaceRepoId,
        repairDiff: snapshot.repairDiff,
        repairPaths: snapshot.repairPaths,
        proposal: {
          headCommit,
          changedPaths: snapshot.changedPaths,
          diff: snapshot.diff,
          evidence: { checks: [] },
          agent: this.config,
          agentSummary: summary,
        },
      }
    } finally {
      const results = await Promise.allSettled([
        sandbox?.close(),
        ...accesses.map((access) => this.repositories.revoke(access)),
      ])
      cleanupFailed = results.some((result) => result.status === "rejected")
    }
    if (cleanupFailed) throw new Error("Technician workspace cleanup failed")
    return result
  }
}
