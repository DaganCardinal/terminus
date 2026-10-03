import type { RepositoryHost, RepoRef } from "./repository-host"
import {
  git,
  remoteHead,
  RepositoryMovedError,
  requireCommit,
  type GitWorkspaceFactory,
  type RepositoryAccess,
  type GitWorkspace,
} from "./git"

/** Only the binding capabilities this adapter uses. No Cloudflare dependency leaks inward. */
export interface ArtifactsRepository {
  name: string
  remote: string
  defaultBranch: string
  description: string | null
  createToken(
    scope: "read" | "write",
    ttl: number
  ): Promise<{ id: string; plaintext: string }>
  revokeToken(id: string): Promise<boolean>
  fork(
    name: string,
    options: { description: string; defaultBranchOnly: boolean }
  ): Promise<{ token: string }>
}

export interface ArtifactsService {
  get(name: string): Promise<ArtifactsRepository>
  create(
    name: string,
    options: { setDefaultBranch: string; description: string }
  ): Promise<{ token: string }>
  import(input: {
    source: { url: string }
    target: { name: string; opts: { description: string } }
  }): Promise<{ token: string }>
}

export class ArtifactsRepositoryHost implements RepositoryHost {
  private readonly artifacts: ArtifactsService
  private readonly workspaces: GitWorkspaceFactory
  private readonly pause: () => Promise<void>
  constructor(
    artifacts: ArtifactsService,
    workspaces: GitWorkspaceFactory,
    pause: () => Promise<void>
  ) {
    this.artifacts = artifacts
    this.workspaces = workspaces
    this.pause = pause
  }

  async createTerminus(input: {
    name: string
    sourceUrl?: string
  }): Promise<RepoRef> {
    const description = `Terminus baseline: ${input.sourceUrl ?? "empty"}`
    let initialToken: string | undefined
    try {
      const created = input.sourceUrl
        ? await this.artifacts.import({
            source: { url: input.sourceUrl },
            target: { name: input.name, opts: { description } },
          })
        : await this.artifacts.create(input.name, {
            setDefaultBranch: "main",
            description,
          })
      initialToken = created.token
    } catch (error) {
      if (!hasCode(error, "ALREADY_EXISTS")) throw error
    }
    const repo = await this.ready(input.name)
    if (initialToken) await repo.revokeToken(initialToken)
    if (repo.description !== description)
      throw new Error(
        "Repository name belongs to a different onboarding operation"
      )

    return this.withWorkspace(
      [{ repoId: input.name, scope: input.sourceUrl ? "read" : "write" }],
      async (workspace, [access]) => {
        if (!access) throw new Error("Missing repository access")
        let head = await remoteHead(workspace, access)
        if (!head && !input.sourceUrl) {
          await git(workspace, [
            "init",
            "-b",
            access.branch,
            "/workspace/initial",
          ])
          await git(
            workspace,
            [
              "-c",
              "user.name=Terminus",
              "-c",
              "user.email=terminus@localhost",
              "commit",
              "--allow-empty",
              "-m",
              "Initialize Terminus",
            ],
            "/workspace/initial"
          )
          await git(
            workspace,
            ["push", "--", access.remote, `HEAD:refs/heads/${access.branch}`],
            "/workspace/initial"
          )
          head = await remoteHead(workspace, access)
        }
        if (!head)
          throw new Error("The imported project has no default-branch commit")
        return { repoId: repo.name, headCommit: head }
      }
    )
  }

  async fork(input: {
    sourceRepoId: string
    commit: string
    name: string
  }): Promise<RepoRef> {
    requireCommit(input.commit)
    const description = `Terminus fork: ${input.sourceRepoId}@${input.commit}`
    // A completed fork is reusable even if its source has since advanced.
    let target: ArtifactsRepository | undefined
    try {
      target = await this.ready(input.name)
    } catch (error) {
      if (!hasCode(error, "NOT_FOUND")) throw error
    }
    if (!target) {
      const source = await this.ready(input.sourceRepoId)
      let initialToken: string | undefined
      try {
        await this.withWorkspace(
          [{ repoId: input.sourceRepoId, scope: "read" }],
          async (workspace, [access]) => {
            if (!access) throw new Error("Missing repository access")
            if ((await remoteHead(workspace, access)) !== input.commit) {
              throw new RepositoryMovedError(
                "Fork source moved from the requested commit; reload and review"
              )
            }
            try {
              initialToken = (
                await source.fork(input.name, {
                  description,
                  defaultBranchOnly: true,
                })
              ).token
            } catch (error) {
              if (!hasCode(error, "ALREADY_EXISTS")) throw error
            }
          }
        )
      } finally {
        if (initialToken) {
          target = await this.ready(input.name)
          await target.revokeToken(initialToken)
        }
      }
      target ??= await this.ready(input.name)
    }
    if (target.description !== description)
      throw new Error("Repository name belongs to a different fork operation")
    return this.withWorkspace(
      [{ repoId: input.name, scope: "read" }],
      async (workspace, [access]) => {
        if (!access) throw new Error("Missing repository access")
        if ((await remoteHead(workspace, access)) !== input.commit) {
          throw new RepositoryMovedError(
            "Fork did not preserve the requested commit"
          )
        }
        return { repoId: input.name, headCommit: input.commit }
      }
    )
  }

  async fastForward(input: {
    targetRepoId: string
    sourceRepoId: string
    fromCommit: string
    toCommit: string
  }): Promise<void> {
    requireCommit(input.fromCommit)
    requireCommit(input.toCommit)
    return this.withWorkspace(
      [
        { repoId: input.sourceRepoId, scope: "read" },
        { repoId: input.targetRepoId, scope: "write" },
      ],
      async (workspace, [source, target]) => {
        if (!source || !target) throw new Error("Missing repository access")
        const head = await remoteHead(workspace, target)
        if (head === input.toCommit) return
        if (head !== input.fromCommit)
          throw new RepositoryMovedError(
            "Train repository moved; the proposal must be reviewed again"
          )
        await git(workspace, [
          "clone",
          "--no-checkout",
          "--",
          source.remote,
          "/workspace/repo",
        ])
        const ancestor = await workspace.run(
          [
            "git",
            "merge-base",
            "--is-ancestor",
            input.fromCommit,
            input.toCommit,
          ],
          "/workspace/repo"
        )
        if (ancestor.exitCode !== 0)
          throw new RepositoryMovedError(
            "Proposed commit is not a descendant of the Train commit"
          )
        // Compare the head advertised for this push, then let Git's server-side
        // old-object check protect the final update. No force push is involved.
        const hook = `#!/bin/sh\nwhile read local_ref local_oid remote_ref remote_oid; do\n  [ "$remote_oid" = "${input.fromCommit}" ] || [ "$remote_oid" = "${input.toCommit}" ] || exit 1\ndone\n`
        const installed = await workspace.run([
          "node",
          "-e",
          "const fs = require('node:fs'); fs.mkdirSync(process.argv[1], {recursive:true}); fs.writeFileSync(process.argv[1] + '/pre-push', process.argv[2], {mode:0o700})",
          "/workspace/hooks",
          hook,
        ])
        if (installed.exitCode !== 0)
          throw new Error("Could not install the Train acceptance guard")
        await git(
          workspace,
          ["config", "core.hooksPath", "/workspace/hooks"],
          "/workspace/repo"
        )
        try {
          await git(
            workspace,
            [
              "push",
              "--",
              target.remote,
              `${input.toCommit}:refs/heads/${target.branch}`,
            ],
            "/workspace/repo"
          )
        } catch (error) {
          const current = await remoteHead(workspace, target)
          if (current === input.toCommit) return
          if (current !== input.fromCommit)
            throw new RepositoryMovedError(
              "Train moved during acceptance; re-review the proposal"
            )
          throw error
        }
        if ((await remoteHead(workspace, target)) !== input.toCommit)
          throw new RepositoryMovedError(
            "Train did not reach the accepted commit"
          )
      }
    )
  }

  async access(
    repoId: string,
    scope: "read" | "write"
  ): Promise<RepositoryAccess> {
    const repo = await this.ready(repoId)
    const token = await repo.createToken(scope, 3600)
    return {
      repoId: repo.name,
      remote: repo.remote,
      branch: repo.defaultBranch,
      token: token.plaintext,
      tokenId: token.id,
      scope,
    }
  }

  async revoke(access: RepositoryAccess): Promise<void> {
    const repo = await this.ready(access.repoId)
    await repo.revokeToken(access.tokenId)
  }

  private async withWorkspace<T>(
    specs: { repoId: string; scope: "read" | "write" }[],
    run: (workspace: GitWorkspace, accesses: RepositoryAccess[]) => Promise<T>
  ): Promise<T> {
    const accesses: RepositoryAccess[] = []
    let workspace: GitWorkspace | undefined
    let result: T
    let cleanupFailed: boolean
    try {
      for (const spec of specs)
        accesses.push(await this.access(spec.repoId, spec.scope))
      workspace = await this.workspaces.open(accesses)
      result = await run(workspace, accesses)
    } finally {
      // Cleanup all credentials even if workspace creation or shutdown fails.
      const results = await Promise.allSettled([
        workspace?.close(),
        ...accesses.map((access) => this.revoke(access)),
      ])
      cleanupFailed = results.some((result) => result.status === "rejected")
    }
    if (cleanupFailed) throw new Error("Repository workspace cleanup failed")
    return result
  }

  private async ready(name: string): Promise<ArtifactsRepository> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.artifacts.get(name)
      } catch (error) {
        if (
          attempt >= 29 ||
          (!hasCode(error, "IMPORT_IN_PROGRESS") &&
            !hasCode(error, "FORK_IN_PROGRESS"))
        )
          throw error
        await this.pause()
      }
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}
