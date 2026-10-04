import {
  IntegrationGit,
  type ArtifactsRepositoryHost,
  type GitWorkspaceFactory,
} from "@terminus/artifacts"
import type { CheckResult, Evidence } from "@terminus/domain"
import {
  commandResultSchema,
  validationCommandsSchema,
  type IntegrationCandidate,
  type ValidationCommand,
} from "@terminus/protocol"

export interface IntegrationValidator {
  validate(
    candidate: IntegrationCandidate,
    commands: ValidationCommand[]
  ): Promise<Evidence>
}

export class SandboxIntegrationValidator implements IntegrationValidator {
  private readonly repositories: Pick<
    ArtifactsRepositoryHost,
    "access" | "revoke"
  >
  private readonly workspaces: GitWorkspaceFactory
  constructor(
    repositories: Pick<ArtifactsRepositoryHost, "access" | "revoke">,
    workspaces: GitWorkspaceFactory
  ) {
    this.repositories = repositories
    this.workspaces = workspaces
  }

  async validate(
    candidate: IntegrationCandidate,
    commands: ValidationCommand[]
  ): Promise<Evidence> {
    const validation = validationCommandsSchema.parse(commands)
    const access = await this.repositories.access(candidate.repoId, "read")
    let workspace: import("@terminus/artifacts").GitWorkspace | undefined
    try {
      // No Train or Terminus write capability, and no model access. Validation
      // scripts execute in a fresh checkout of the durable merge commit.
      workspace = await this.workspaces.open([access])
      const repository = new IntegrationGit(
        workspace,
        access,
        candidate.headCommit
      )
      await repository.checkout()
      const checks: CheckResult[] = []
      const run = async (name: string, command: string[]) => {
        const result = commandResultSchema.parse(
          await workspace!.run(command, "/workspace/repo")
        )
        const passed = result.exitCode === 0 && !result.outputTruncated
        checks.push({
          name,
          command,
          required: true,
          status: passed ? "passed" : "failed",
          ...result,
        })
        return passed
      }
      const installed = await run("npm ci", ["npm", "ci"])
      for (const check of validation) {
        if (installed) await run(check.name, check.command)
        else
          checks.push({
            name: check.name,
            command: check.command,
            required: true,
            status: "skipped",
          })
      }
      await repository.assertUnchanged()
      return { checks }
    } finally {
      await Promise.allSettled([
        workspace?.close(),
        this.repositories.revoke(access),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Integration validation cleanup failed")
      })
    }
  }
}

export class FakeIntegrationValidator implements IntegrationValidator {
  async validate(
    _: IntegrationCandidate,
    commands: ValidationCommand[]
  ): Promise<Evidence> {
    return {
      checks: commands.map(({ name, command }) => ({
        name,
        command,
        required: true,
        status: "passed",
      })),
    }
  }
}
