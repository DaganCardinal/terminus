import {
  parseRepoId,
  repoId as namespacedRepoId,
  siblingRepoId,
  TERMINUS_REPO_NAME,
  type IntegrationMergeInput,
  type IntegrationMerge,
  type RepositoryHost,
  type RepoRef,
} from "./repository-host"
import { TechnicianGit, type RepairGitInput } from "./technician-git"
import { prepareMerge } from "./integration-git"
import {
  readCommittedFile,
  readRepositoryFile,
  readRepositoryOverview,
  type CommittedObjects,
} from "./repository-browse"
import type { HeadReader } from "./smart-http"
import { ArtifactsApiError } from "./artifacts-rest"
import {
  git,
  remoteHead,
  RepositoryMovedError,
  requireCommit,
  type GitWorkspaceFactory,
  type RepositoryAccess,
  type GitWorkspace,
} from "./git"
import { perf, perfSpan } from "@terminus/protocol"

type ForkInput = Parameters<RepositoryHost["fork"]>[0]

/** Only the Artifacts capabilities this adapter uses. No Cloudflare dependency leaks inward. */
export interface ArtifactsRepositoryInfo {
  name: string
  remote: string
  defaultBranch: string
  description: string | null
}

export interface ArtifactsRepository extends Disposable {
  info(): Promise<ArtifactsRepositoryInfo>
  createToken(
    scope: "read" | "write",
    ttl: number
  ): Promise<{ id: string; plaintext: string }>
  revokeToken(id: string): Promise<boolean>
  /** Deletes the repository, or succeeds if it is already gone. */
  delete(): Promise<void>
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
    target: { name: string }
  }): Promise<{ token: string }>
  /** Reads committed objects by hash; without it, reading a file opens a workspace. */
  objects?(name: string): CommittedObjects
}

/** Artifacts across namespaces: one per Project. */
export interface ArtifactsNamespaces {
  /** Creates the namespace, or succeeds if it already exists. */
  ensure(namespace: string): Promise<void>
  namespace(namespace: string): ArtifactsService
}

export class ArtifactsRepositoryHost implements RepositoryHost {
  private readonly artifacts: ArtifactsNamespaces
  private readonly workspaces: GitWorkspaceFactory
  private readonly pause: () => Promise<void>
  private readonly readHead: HeadReader | undefined
  /** Without `readHead`, reading a head opens a workspace to run `git ls-remote`. */
  constructor(
    artifacts: ArtifactsNamespaces,
    workspaces: GitWorkspaceFactory,
    pause: () => Promise<void>,
    readHead?: HeadReader
  ) {
    this.artifacts = artifacts
    this.workspaces = workspaces
    this.pause = pause
    this.readHead = readHead
  }

  async inspectRepair(input: RepairGitInput, candidate: RepoRef) {
    return this.withWorkspace(
      [
        { repoId: candidate.repoId, scope: "read" },
        { repoId: input.source.trainRepoId, scope: "read" },
      ],
      async (workspace, [access, train]) => {
        if (!access || !train)
          throw new Error("Missing repair repository access")
        const repository = new TechnicianGit(workspace, access, train, input)
        const saved = await repository.prepare()
        if (saved !== candidate.headCommit)
          throw new RepositoryMovedError(
            "Repair repository no longer contains the reviewed candidate"
          )
        return repository.snapshot(candidate.headCommit)
      }
    )
  }

  async confirmRepair(input: RepairGitInput, candidate: RepoRef) {
    const [train, saved] = await Promise.all([
      this.currentHead(input.source.trainRepoId),
      this.currentHead(candidate.repoId),
    ])
    if (train !== input.source.trainCommit)
      throw new RepositoryMovedError("Train moved before repair")
    if (saved !== candidate.headCommit)
      throw new RepositoryMovedError(
        "Repair repository no longer contains the reviewed candidate"
      )
  }

  async head(repoId: string): Promise<string> {
    const head = await this.currentHead(repoId)
    if (!head) throw new Error("Repository has no default-branch commit")
    return head
  }

  async readOverview(repoId: string, commit: string) {
    return this.withWorkspace(
      [{ repoId, scope: "read" }],
      async (workspace, [access]) => {
        if (!access) throw new Error("Missing repository access")
        return readRepositoryOverview(workspace, access, commit)
      }
    )
  }

  async readFile(repoId: string, commit: string, path: string) {
    const { namespace, name } = parseRepoId(repoId)
    const objects = this.artifacts.namespace(namespace).objects?.(name)
    if (objects) return readCommittedFile(objects, commit, path)
    return this.withWorkspace(
      [{ repoId, scope: "read" }],
      async (workspace, [access]) => {
        if (!access) throw new Error("Missing repository access")
        return readRepositoryFile(workspace, access, commit, path)
      }
    )
  }

  /** TEMPORARY benchmark instrumentation wrapper. */
  prepareIntegration(input: IntegrationMergeInput): Promise<IntegrationMerge> {
    return perfSpan("artifacts.prepare_integration", { id: input.id }, () =>
      this.prepareIntegrationUntimed(input)
    )
  }

  private async prepareIntegrationUntimed(
    input: IntegrationMergeInput
  ): Promise<IntegrationMerge> {
    for (const commit of [
      input.terminusCommit,
      input.trainCommit,
      input.trainBaseline,
      ...input.acceptedCommits,
    ])
      requireCommit(commit)
    // Unlike a Station fork, a candidate may already contain its completed
    // merge after a lost response. Check its identity and parents below.
    const candidateId = siblingRepoId(input.terminusRepoId, input.id)
    try {
      using candidate = await this.ready(candidateId)
      if (
        (await candidate.info()).description !==
        `Terminus fork: ${input.terminusRepoId}@${input.terminusCommit}`
      )
        throw new Error("Repository belongs to another integration attempt")
    } catch (error) {
      if (!hasCode(error, "NOT_FOUND")) throw error
      await this.fork({
        sourceRepoId: input.terminusRepoId,
        commit: input.terminusCommit,
        name: input.id,
      })
    }
    return this.withWorkspace(
      [
        { repoId: candidateId, scope: "write" },
        { repoId: input.trainRepoId, scope: "read" },
      ],
      async (workspace, [candidate, train]) => {
        if (!candidate || !train) throw new Error("Missing repository access")
        return prepareMerge(workspace, candidate, train, input)
      }
    )
  }

  async inspectIntegration(input: IntegrationMergeInput, candidate: RepoRef) {
    return this.withWorkspace(
      [{ repoId: candidate.repoId, scope: "read" }],
      async (workspace, [access]) => {
        if (!access) throw new Error("Missing candidate access")
        const directory = "/workspace/inspect"
        await git(workspace, [
          "clone",
          "--no-checkout",
          "--",
          access.remote,
          directory,
        ])
        const diff = await git(
          workspace,
          [
            "diff",
            "--binary",
            "--full-index",
            input.terminusCommit,
            candidate.headCommit,
          ],
          directory
        )
        const changedPaths = (
          await git(
            workspace,
            [
              "diff",
              "--name-only",
              "-z",
              input.terminusCommit,
              candidate.headCommit,
            ],
            directory
          )
        )
          .split("\0")
          .filter(Boolean)
        if (diff.length > 200000)
          throw new Error("Crossing diff exceeds review limit")
        return { diff, changedPaths }
      }
    )
  }
  async createTerminus(input: {
    namespace: string
    sourceUrl?: string
  }): Promise<RepoRef> {
    // The namespace belongs to one Project, so its Terminus name cannot
    // collide with another onboarding operation.
    const id = namespacedRepoId(input.namespace, TERMINUS_REPO_NAME)
    await this.artifacts.ensure(input.namespace)
    const artifacts = this.artifacts.namespace(input.namespace)
    let initialToken: string | undefined
    try {
      const created = input.sourceUrl
        ? await artifacts.import({
            source: { url: input.sourceUrl },
            target: { name: TERMINUS_REPO_NAME },
          })
        : await artifacts.create(TERMINUS_REPO_NAME, {
            setDefaultBranch: "main",
            description: "Terminus baseline: empty",
          })
      initialToken = created.token
    } catch (error) {
      if (!hasCode(error, "ALREADY_EXISTS")) throw error
    }
    if (initialToken) {
      using repo = await this.ready(id)
      await repo.revokeToken(initialToken)
    }

    return this.withWorkspace(
      [{ repoId: id, scope: input.sourceUrl ? "read" : "write" }],
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
        return { repoId: id, headCommit: head }
      }
    )
  }

  /** TEMPORARY benchmark instrumentation wrapper. */
  fork(input: ForkInput): Promise<RepoRef> {
    return perfSpan("artifacts.fork", { name: input.name }, () =>
      this.forkUntimed(input)
    )
  }

  private async forkUntimed(input: ForkInput): Promise<RepoRef> {
    requireCommit(input.commit)
    const id = siblingRepoId(input.sourceRepoId, input.name)
    const description = (source: string) =>
      `Terminus fork: ${source}@${input.commit}`
    const preferred =
      input.preferredSourceRepoId !== undefined &&
      input.preferredSourceRepoId !== input.sourceRepoId
        ? input.preferredSourceRepoId
        : null
    const fork = { id, name: input.name, commit: input.commit }
    // A completed fork is reusable even if its source has since advanced.
    let existing = await this.forkDescription(id)
    if (existing === null) {
      const source =
        preferred && (await this.headIfReadable(preferred)) === input.commit
          ? preferred
          : input.sourceRepoId
      perf("artifacts.fork_source", {
        name: input.name,
        source: parseRepoId(source).name,
      })
      await this.createFork(source, fork, description(source), {
        // The preferred source's head was just read.
        checkHead: source !== preferred,
      })
      existing = await this.forkDescription(id)
    }
    if (
      existing !== description(input.sourceRepoId) &&
      (!preferred || existing !== description(preferred))
    )
      throw new Error("Repository name belongs to a different fork operation")
    if ((await this.currentHead(id)) === input.commit)
      return { repoId: id, headCommit: input.commit }
    if (!preferred || existing !== description(preferred))
      throw new RepositoryMovedError(
        "Fork did not preserve the requested commit"
      )
    // The preferred source moved while Artifacts forked it. That copy is this
    // operation's own and can never be used, so fork the source instead.
    perf("artifacts.fork_replaced", { name: input.name })
    {
      using copy = await this.ready(id)
      await copy.delete()
    }
    await this.createFork(
      input.sourceRepoId,
      fork,
      description(input.sourceRepoId),
      { checkHead: true }
    )
    if ((await this.forkDescription(id)) !== description(input.sourceRepoId))
      throw new Error("Repository name belongs to a different fork operation")
    if ((await this.currentHead(id)) !== input.commit)
      throw new RepositoryMovedError(
        "Fork did not preserve the requested commit"
      )
    return { repoId: id, headCommit: input.commit }
  }

  /** The description of the repository at `id`, or null when there is none. */
  private async forkDescription(id: string): Promise<string | null> {
    let target: ArtifactsRepository
    try {
      target = await this.ready(id)
    } catch (error) {
      if (!hasCode(error, "NOT_FOUND")) throw error
      return null
    }
    try {
      return (await target.info()).description ?? ""
    } finally {
      target[Symbol.dispose]()
    }
  }

  /** A preferred fork source is optional, so failing to read it means not using it. */
  private async headIfReadable(repoId: string): Promise<string | null> {
    try {
      return await this.currentHead(repoId)
    } catch {
      return null
    }
  }

  /** Starts a server-side fork of `sourceId`. The caller checks what it made. */
  private async createFork(
    sourceId: string,
    fork: { id: string; name: string; commit: string },
    description: string,
    options: { checkHead: boolean }
  ): Promise<void> {
    using source = await this.ready(sourceId)
    let initialToken: string | undefined
    try {
      if (
        options.checkHead &&
        (await this.currentHead(sourceId)) !== fork.commit
      )
        throw new RepositoryMovedError(
          "Fork source moved from the requested commit; reload and review"
        )
      try {
        initialToken = (
          await source.fork(fork.name, { description, defaultBranchOnly: true })
        ).token
      } catch (error) {
        if (!hasCode(error, "ALREADY_EXISTS")) throw error
      }
    } finally {
      if (initialToken) {
        using target = await this.ready(fork.id)
        await target.revokeToken(initialToken)
      }
    }
  }

  /** TEMPORARY benchmark instrumentation wrapper. */
  fastForward(input: {
    targetRepoId: string
    sourceRepoId: string
    fromCommit: string
    toCommit: string
  }): Promise<void> {
    return perfSpan(
      "artifacts.fast_forward",
      { target: parseRepoId(input.targetRepoId).name },
      () => this.fastForwardUntimed(input)
    )
  }

  private async fastForwardUntimed(input: {
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
            "Target repository moved; the candidate must be reviewed again"
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
            "Candidate is not a descendant of the target commit"
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
          throw new Error("Could not install the repository promotion guard")
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
              "Target moved during promotion; revalidate the candidate"
            )
          throw error
        }
        if ((await remoteHead(workspace, target)) !== input.toCommit)
          throw new RepositoryMovedError(
            "Target did not reach the accepted commit"
          )
      }
    )
  }

  async access(
    repoId: string,
    scope: "read" | "write"
  ): Promise<RepositoryAccess> {
    const started = Date.now()
    try {
      return await this.accessUntimed(repoId, scope)
    } finally {
      perf("artifacts.access", {
        repo: parseRepoId(repoId).name,
        scope,
        ms: Date.now() - started,
      })
    }
  }

  private async accessUntimed(
    repoId: string,
    scope: "read" | "write"
  ): Promise<RepositoryAccess> {
    using repo = await this.ready(repoId)
    const info = await repo.info()
    const token = await repo.createToken(scope, 3600)
    return {
      repoId,
      remote: info.remote,
      branch: info.defaultBranch,
      token: token.plaintext,
      tokenId: token.id,
      scope,
    }
  }

  async revoke(access: RepositoryAccess): Promise<void> {
    const started = Date.now()
    using repo = await this.ready(access.repoId)
    await repo.revokeToken(access.tokenId)
    perf("artifacts.revoke", {
      repo: parseRepoId(access.repoId).name,
      ms: Date.now() - started,
    })
  }

  /** The default-branch head, read without a Sandbox when the host can. */
  private async currentHead(repoId: string): Promise<string | null> {
    return perfSpan(
      "artifacts.head",
      { repo: parseRepoId(repoId).name, viaSandbox: !this.readHead },
      () => this.currentHeadUntimed(repoId)
    )
  }

  private async currentHeadUntimed(repoId: string): Promise<string | null> {
    if (!this.readHead)
      return this.withWorkspace(
        [{ repoId, scope: "read" }],
        async (workspace, [access]) => {
          if (!access) throw new Error("Missing repository access")
          return remoteHead(workspace, access)
        }
      )
    const access = await this.access(repoId, "read")
    try {
      return await this.readHead(access)
    } finally {
      await this.revoke(access)
    }
  }

  private async withWorkspace<T>(
    specs: { repoId: string; scope: "read" | "write" }[],
    run: (workspace: GitWorkspace, accesses: RepositoryAccess[]) => Promise<T>
  ): Promise<T> {
    const accesses: RepositoryAccess[] = []
    let workspace: GitWorkspace | undefined
    let result: T
    let cleanupFailed: boolean
    // TEMPORARY benchmark instrumentation.
    const started = Date.now()
    let openedAt = started
    let ranAt = started
    try {
      for (const spec of specs)
        accesses.push(await this.access(spec.repoId, spec.scope))
      const accessedAt = Date.now()
      workspace = await this.workspaces.open(accesses)
      openedAt = Date.now()
      perf("artifacts.workspace_opened", {
        repos: specs.map(
          (spec) => `${parseRepoId(spec.repoId).name}:${spec.scope}`
        ),
        accessMs: accessedAt - started,
        openMs: openedAt - accessedAt,
      })
      result = await run(workspace, accesses)
      ranAt = Date.now()
    } finally {
      // Cleanup all credentials even if workspace creation or shutdown fails.
      const results = await Promise.allSettled([
        workspace?.close(),
        ...accesses.map((access) => this.revoke(access)),
      ])
      cleanupFailed = results.some((result) => result.status === "rejected")
      perf("artifacts.workspace", {
        repos: specs.map(
          (spec) => `${parseRepoId(spec.repoId).name}:${spec.scope}`
        ),
        totalMs: Date.now() - started,
        runMs: ranAt > openedAt ? ranAt - openedAt : null,
        cleanupMs: Date.now() - Math.max(ranAt, openedAt),
      })
    }
    if (cleanupFailed) throw new Error("Repository workspace cleanup failed")
    return result
  }

  private async ready(id: string): Promise<ArtifactsRepository> {
    const { namespace, name } = parseRepoId(id)
    let denials = 0
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.artifacts.namespace(namespace).get(name)
      } catch (error) {
        if (isTransientDenial(error) && denials < transientDenialRetries) {
          // Backs off 1, 2, 4, then 8 pauses at a time: about a minute in all.
          const pauses = Math.min(2 ** denials++, 8)
          perf("artifacts.denied_pause", { name, attempt: denials, pauses })
          for (let pause = 0; pause < pauses; pause++) await this.pause()
          continue
        }
        if (
          attempt >= 29 ||
          (!hasCode(error, "IMPORT_IN_PROGRESS") &&
            !hasCode(error, "FORK_IN_PROGRESS"))
        )
          throw error
        perf("artifacts.not_ready_pause", { name, attempt })
        await this.pause()
      }
    }
  }
}

/** Retries of a transient denial before it is treated as real. */
const transientDenialRetries = 10

/**
 * Artifacts intermittently refuses to read a repository with HTTP 403 and
 * API code 10004 (not an Artifacts code), whether or not the repository
 * exists. Every observed case cleared within a minute, and a retry after the
 * first refusal returns within milliseconds.
 */
function isTransientDenial(error: unknown): boolean {
  return (
    error instanceof ArtifactsApiError &&
    error.status === 403 &&
    error.apiCode === 10004
  )
}

/** Unrelated failures must never trigger repository creation. */
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}
