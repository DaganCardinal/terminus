import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  ArtifactsRepositoryHost,
  type ArtifactsRepository,
  type ArtifactsService,
} from "./artifacts-repository-host"
import {
  RepositoryMovedError,
  type GitWorkspace,
  type GitWorkspaceFactory,
  type RepositoryAccess,
} from "./git"
import { StationGit } from "./station-git"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function fixture(options: { remoteErrors?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-git-test-"))
  temporary.push(directory)
  const repos = new Map<string, ArtifactsRepository>()
  const tokens = new Set<string>()
  const handles = new Set<symbol>()
  const grants: RepositoryAccess[][] = []
  let beforeFork: (() => Promise<void>) | null = null
  let beforePush: (() => Promise<void>) | null = null
  let serial = 0
  async function create(name: string, description: string, source?: string) {
    if (repos.has(name))
      throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" })
    const remote = join(directory, `${name}.git`)
    if (source) await execute("git", ["clone", "--bare", "--", source, remote])
    else await execute("git", ["init", "--bare", "-b", "main", remote])
    const issue = () => {
      const id = `token-${++serial}`
      tokens.add(id)
      return id
    }
    const repo: ArtifactsRepository = {
      // RPC handles expose methods only. Metadata must come from info().
      info: async () => ({ name, description, remote, defaultBranch: "main" }),
      [Symbol.dispose]: () => {},
      createToken: async () => {
        const id = issue()
        return { id, plaintext: id }
      },
      revokeToken: async (id) => tokens.delete(id),
      fork: async (target, options) => {
        await beforeFork?.()
        return create(target, options.description, remote)
      },
    }
    repos.set(name, repo)
    return { token: issue() }
  }
  const artifacts: ArtifactsService = {
    get: async (name) => {
      const repo = repos.get(name)
      if (!repo) {
        if (options.remoteErrors)
          throw new Error(`ArtifactsError: Repository not found: ${name}.`)
        throw Object.assign(new Error("missing"), { code: "NOT_FOUND" })
      }
      const handle = Symbol(name)
      handles.add(handle)
      return {
        ...repo,
        [Symbol.dispose]: () => {
          handles.delete(handle)
        },
      }
    },
    create: (name, options) => create(name, options.description),
    import: (input) =>
      create(
        input.target.name,
        input.target.opts.description,
        input.source.url
      ),
  }
  const workspaces: GitWorkspaceFactory = {
    open: async (access) => {
      grants.push(access)
      const path = join(directory, `workspace-${++serial}`)
      await mkdir(path)
      const translate = (value: string) =>
        value.startsWith("/workspace")
          ? value.replace("/workspace", path)
          : value
      const workspace: GitWorkspace = {
        run: async (command, cwd = "/workspace", env = {}) => {
          if (command[0] === "git" && command.includes("push") && beforePush) {
            const callback = beforePush
            beforePush = null
            await callback()
          }
          try {
            const output = await execute(
              command[0]!,
              command.slice(1).map(translate),
              {
                cwd: translate(cwd),
                env: { ...process.env, ...env },
                maxBuffer: 2_000_000,
              }
            )
            return { exitCode: 0, ...output }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              !("stdout" in error) ||
              !("stderr" in error)
            )
              throw error
            return {
              exitCode: typeof error.code === "number" ? error.code : 1,
              stdout: String(error.stdout),
              stderr: String(error.stderr),
            }
          }
        },
        close: () => rm(path, { recursive: true, force: true }),
      }
      return workspace
    },
  }
  const host = new ArtifactsRepositoryHost(
    artifacts,
    workspaces,
    async () => {}
  )
  async function head(name: string) {
    return (
      await execute("git", [
        "--git-dir",
        (await repos.get(name)!.info()).remote,
        "rev-parse",
        "main",
      ])
    ).stdout.trim()
  }
  async function change(
    name: string,
    filename = "README.md",
    text = "candidate\n"
  ) {
    const access = await host.access(name, "write")
    const workspace = await workspaces.open([access])
    const base = await head(name)
    const station = new StationGit(workspace, access, base)
    await station.prepare()
    const output = await workspace.run(
      [
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        filename,
        text,
      ],
      "/workspace/repo"
    )
    expect(output.exitCode).toBe(0)
    const commit = await station.candidate("Test candidate")
    const snapshot = await station.snapshot(commit)
    await station.publish(commit)
    await workspace.close()
    await host.revoke(access)
    return { commit, snapshot }
  }
  return {
    host,
    head,
    change,
    tokens,
    handles,
    grants,
    repos,
    workspaces,
    artifacts,
    setBeforePush: (callback: () => Promise<void>) => {
      beforePush = callback
    },
    setBeforeFork: (callback: () => Promise<void>) => {
      beforeFork = callback
    },
  }
}

describe("Artifacts repository transport with real Git", () => {
  it("creates Train and Station repos when remote RPC drops the missing-target error code", async () => {
    const f = await fixture({ remoteErrors: true })
    const terminus = await f.host.createTerminus({ name: "terminus" })
    const train = await f.host.fork({
      sourceRepoId: terminus.repoId,
      commit: terminus.headCommit,
      name: "train",
    })
    expect(train).toEqual({ repoId: "train", headCommit: terminus.headCommit })
    expect(await f.head("train")).toBe(terminus.headCommit)
    const station = await f.host.fork({
      sourceRepoId: train.repoId,
      commit: train.headCommit,
      name: "station",
    })
    expect(station).toEqual({ repoId: "station", headCommit: train.headCommit })
    expect(await f.head("station")).toBe(train.headCommit)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("propagates a missing source reported by remote RPC", async () => {
    const f = await fixture({ remoteErrors: true })
    await expect(
      f.host.fork({
        sourceRepoId: "missing-source",
        commit: "a".repeat(40),
        name: "train",
      })
    ).rejects.toThrow("ArtifactsError: Repository not found: missing-source.")
    expect(f.repos.has("train")).toBe(false)
    expect(f.grants).toHaveLength(0)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it.each([
    new Error("ArtifactsError: Repository not found: different-repo."),
    new Error("Repository not found: train."),
    new Error("ArtifactsError: Upstream unavailable"),
    Object.assign(new Error("ArtifactsError: Repository not found: train."), {
      code: "UPSTREAM_UNAVAILABLE",
    }),
  ])(
    "does not treat unrelated lookup errors as an absent fork target: %s",
    async (error) => {
      const f = await fixture()
      f.artifacts.get = async () => {
        throw error
      }
      await expect(
        f.host.fork({
          sourceRepoId: "terminus",
          commit: "a".repeat(40),
          name: "train",
        })
      ).rejects.toBe(error)
      expect(f.repos.size).toBe(0)
      expect(f.grants).toHaveLength(0)
      expect(f.tokens.size).toBe(0)
    }
  )

  it("creates, forks, commits a Station, and fast-forwards the Train without rewriting provenance", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    expect(await f.host.createTerminus({ name: "terminus" })).toEqual(terminus)
    const train = await f.host.fork({
      sourceRepoId: "terminus",
      commit: terminus.headCommit,
      name: "train",
    })
    const station = await f.host.fork({
      sourceRepoId: train.repoId,
      commit: train.headCommit,
      name: "station",
    })
    expect(
      await f.host.fork({
        sourceRepoId: "train",
        commit: train.headCommit,
        name: "station",
      })
    ).toEqual(station)
    const proposed = await f.change("station", "a file\nwith spaces.md")
    expect(proposed.snapshot.changedPaths).toEqual(["a file\nwith spaces.md"])
    expect(proposed.snapshot.diff).toContain("+candidate")
    const input = {
      sourceRepoId: "station",
      targetRepoId: "train",
      fromCommit: train.headCommit,
      toCommit: proposed.commit,
    }
    await f.host.fastForward(input)
    await f.host.fastForward(input)
    expect(await f.head("train")).toBe(proposed.commit)
    expect(await f.head("terminus")).toBe(terminus.headCommit)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
    expect(
      f.grants.some(
        (access) =>
          access.length === 2 &&
          access[0]!.scope === "read" &&
          access[1]!.scope === "write"
      )
    ).toBe(true)
  })

  it("reuses a completed fork after its source advances", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ name: "terminus" })
    const input = {
      sourceRepoId: "terminus",
      commit: baseline.headCommit,
      name: "train",
    }
    const train = await f.host.fork(input)
    await f.change("terminus")
    expect(await f.host.fork(input)).toEqual(train)
    expect(f.tokens.size).toBe(0)
  })

  it("revokes tokens when opening a workspace fails", async () => {
    const f = await fixture()
    f.workspaces.open = async () => {
      throw new Error("Sandbox unavailable")
    }
    await expect(f.host.createTerminus({ name: "terminus" })).rejects.toThrow(
      "Sandbox unavailable"
    )
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("revokes the server-issued fork token even if its source workspace shutdown fails", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ name: "terminus" })
    const open = f.workspaces.open.bind(f.workspaces)
    f.workspaces.open = async (access) => {
      const workspace = await open(access)
      return {
        ...workspace,
        close: async () => {
          await workspace.close()
          throw new Error("Shutdown interrupted")
        },
      }
    }
    await expect(
      f.host.fork({
        sourceRepoId: "terminus",
        commit: baseline.headCommit,
        name: "train",
      })
    ).rejects.toThrow("cleanup failed")
    expect(f.tokens.size).toBe(0)
  })

  it("refuses a fork when the source moved from the requested commit", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    await f.change("terminus")
    await expect(
      f.host.fork({
        sourceRepoId: "terminus",
        commit: terminus.headCommit,
        name: "train",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.repos.has("train")).toBe(false)
    expect(f.tokens.size).toBe(0)
  })

  it("detects a source moving during a server-side fork", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    f.setBeforeFork(async () => {
      await f.change("terminus")
    })
    await expect(
      f.host.fork({
        sourceRepoId: "terminus",
        commit: terminus.headCommit,
        name: "train",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.tokens.size).toBe(0)
  })

  it("refuses to overwrite a Train that has moved", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    await f.host.fork({
      sourceRepoId: "terminus",
      commit: terminus.headCommit,
      name: "train",
    })
    await f.host.fork({
      sourceRepoId: "train",
      commit: terminus.headCommit,
      name: "station",
    })
    const proposed = await f.change("station", "proposal.md")
    const other = await f.change("train", "technician.md")
    await expect(
      f.host.fastForward({
        sourceRepoId: "station",
        targetRepoId: "train",
        fromCommit: terminus.headCommit,
        toCommit: proposed.commit,
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(await f.head("train")).toBe(other.commit)
    expect(f.tokens.size).toBe(0)
  })

  it("rejects a Train advancing to an ancestor of the proposal between preflight and push", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ name: "terminus" })
    await f.host.fork({
      sourceRepoId: "terminus",
      commit: baseline.headCommit,
      name: "train",
    })
    await f.host.fork({
      sourceRepoId: "train",
      commit: baseline.headCommit,
      name: "station",
    })
    const first = await f.change("station", "one.md")
    const second = await f.change("station", "two.md")
    f.setBeforePush(async () =>
      f.host.fastForward({
        targetRepoId: "train",
        sourceRepoId: "station",
        fromCommit: baseline.headCommit,
        toCommit: first.commit,
      })
    )
    await expect(
      f.host.fastForward({
        targetRepoId: "train",
        sourceRepoId: "station",
        fromCommit: baseline.headCommit,
        toCommit: second.commit,
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(await f.head("train")).toBe(first.commit)
    expect(f.tokens.size).toBe(0)
  })

  it("rejects validation that leaves uncommitted changes", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    const access = await f.host.access("terminus", "write")
    const workspace = await f.workspaces.open([access])
    const station = new StationGit(workspace, access, terminus.headCommit)
    await station.prepare()
    await workspace.run(
      [
        "node",
        "-e",
        "require('node:fs').writeFileSync('generated.txt', 'changed')",
      ],
      "/workspace/repo"
    )
    await expect(station.snapshot(terminus.headCommit)).rejects.toThrow(
      "Validation changed"
    )
    await workspace.close()
    await f.host.revoke(access)
  })

  it("imports an existing project rather than creating an unrelated history", async () => {
    const f = await fixture()
    const original = await f.host.createTerminus({ name: "original" })
    const changed = await f.change("original")
    const imported = await f.host.createTerminus({
      name: "imported",
      sourceUrl: (await f.repos.get("original")!.info()).remote,
    })
    expect(imported.headCommit).toBe(changed.commit)
    expect(imported.headCommit).not.toBe(original.headCommit)
    expect(
      await f.host.createTerminus({
        name: "imported",
        sourceUrl: (await f.repos.get("original")!.info()).remote,
      })
    ).toEqual(imported)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("rejects reuse for a different onboarding source before granting repository access", async () => {
    const f = await fixture()
    await f.host.createTerminus({ name: "terminus" })
    const grants = f.grants.length
    await expect(
      f.host.createTerminus({
        name: "terminus",
        sourceUrl: "https://example.com/another-project.git",
      })
    ).rejects.toThrow("different onboarding operation")
    expect(f.grants).toHaveLength(grants)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("rejects an existing repository from a different fork operation", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ name: "terminus" })
    await f.host.createTerminus({ name: "unrelated" })
    const grants = f.grants.length
    await expect(
      f.host.fork({
        sourceRepoId: terminus.repoId,
        commit: terminus.headCommit,
        name: "unrelated",
      })
    ).rejects.toThrow("different fork operation")
    expect(f.grants).toHaveLength(grants)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })
})
