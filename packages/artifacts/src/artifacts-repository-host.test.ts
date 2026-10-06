import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  ArtifactsRepositoryHost,
  type ArtifactsNamespaces,
  type ArtifactsRepository,
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "terminus-git-test-"))
  temporary.push(directory)
  const repos = new Map<string, ArtifactsRepository>()
  const tokens = new Set<string>()
  const handles = new Set<symbol>()
  const grants: RepositoryAccess[][] = []
  const namespaces = new Set<string>()
  let lookupError: unknown = null
  let beforeFork: (() => Promise<void>) | null = null
  let beforePush: (() => Promise<void>) | null = null
  let serial = 0
  // Repos are keyed by their `<namespace>/<name>` id.
  async function create(id: string, description: string, source?: string) {
    if (repos.has(id))
      throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" })
    const [namespace, name] = id.split("/")
    const remote = join(directory, `${namespace}--${name}.git`)
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
        return create(`${namespace}/${target}`, options.description, remote)
      },
    }
    repos.set(id, repo)
    return { token: issue() }
  }
  const artifacts: ArtifactsNamespaces = {
    ensure: async (namespace) => {
      namespaces.add(namespace)
    },
    namespace: (namespace) => ({
      get: async (name) => {
        if (lookupError) throw lookupError
        const id = `${namespace}/${name}`
        const repo = repos.get(id)
        if (!repo)
          throw Object.assign(new Error("missing"), { code: "NOT_FOUND" })
        const handle = Symbol(id)
        handles.add(handle)
        return {
          ...repo,
          [Symbol.dispose]: () => {
            handles.delete(handle)
          },
        }
      },
      create: (name, options) =>
        create(`${namespace}/${name}`, options.description),
      import: (input) =>
        create(
          `${namespace}/${input.target.name}`,
          "Imported",
          input.source.url
        ),
    }),
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
    namespaces,
    setLookupError: (error: unknown) => {
      lookupError = error
    },
    setBeforePush: (callback: () => Promise<void>) => {
      beforePush = callback
    },
    setBeforeFork: (callback: () => Promise<void>) => {
      beforeFork = callback
    },
  }
}

describe("Artifacts repository transport with real Git", () => {
  it("reads bounded context from the exact canonical commit using only read grants, without changing its history", async () => {
    const f = await fixture()
    await f.host.createTerminus({ namespace: "p" })
    const saved = await f.change("p/terminus", "README.md", "x".repeat(6000))
    await f.change("p/terminus", ".env", "SECRET=fixture-secret")
    await f.change("p/terminus", "README.md", "newer content")
    const current = await f.head("p/terminus")
    const context = await f.host.readContext("p/terminus", saved.commit)
    expect(context.commit).toBe(saved.commit)
    expect(context.files.find((file) => file.path === "README.md")).toEqual({
      path: "README.md",
      content: "x".repeat(4000),
      truncated: true,
    })
    expect(await f.head("p/terminus")).toBe(current)
    const latest = await f.host.readContext("p/terminus", current)
    expect(latest.paths).not.toContain(".env")
    expect(
      latest.files.some((file) => file.content.includes("fixture-secret"))
    ).toBe(false)
    expect(
      f.grants
        .slice(-2)
        .every((grants) => grants.length === 1 && grants[0]!.scope === "read")
    ).toBe(true)
    expect(f.tokens.size).toBe(0)
    await expect(
      f.host.readContext("p/terminus", "not-a-commit")
    ).rejects.toThrow("full Git commit")
    expect(f.tokens.size).toBe(0)
  })
  it("keeps a Project's Terminus, Train and Station repos in its own namespace", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const train = await f.host.fork({
      sourceRepoId: terminus.repoId,
      commit: terminus.headCommit,
      name: "train",
    })
    expect(train).toEqual({
      repoId: "p/train",
      headCommit: terminus.headCommit,
    })
    expect(await f.head("p/train")).toBe(terminus.headCommit)
    const station = await f.host.fork({
      sourceRepoId: train.repoId,
      commit: train.headCommit,
      name: "station",
    })
    expect(station).toEqual({
      repoId: "p/station",
      headCommit: train.headCommit,
    })
    expect(await f.head("p/station")).toBe(train.headCommit)
    expect(terminus.repoId).toBe("p/terminus")
    expect([...f.namespaces]).toEqual(["p"])
    expect([...f.repos.keys()].sort()).toEqual([
      "p/station",
      "p/terminus",
      "p/train",
    ])
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("refuses repository ids without a namespace", async () => {
    const f = await fixture()
    await expect(f.host.head("terminus")).rejects.toThrow("<namespace>/<name>")
    expect(f.grants).toHaveLength(0)
  })

  it("propagates a missing fork source", async () => {
    const f = await fixture()
    await expect(
      f.host.fork({
        sourceRepoId: "p/missing-source",
        commit: "a".repeat(40),
        name: "train",
      })
    ).rejects.toThrow("missing")
    expect(f.repos.has("p/train")).toBe(false)
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
      f.setLookupError(error)
      await expect(
        f.host.fork({
          sourceRepoId: "p/terminus",
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
    const terminus = await f.host.createTerminus({ namespace: "p" })
    expect(await f.host.createTerminus({ namespace: "p" })).toEqual(terminus)
    const train = await f.host.fork({
      sourceRepoId: "p/terminus",
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
        sourceRepoId: "p/train",
        commit: train.headCommit,
        name: "station",
      })
    ).toEqual(station)
    const proposed = await f.change("p/station", "a file\nwith spaces.md")
    expect(proposed.snapshot.changedPaths).toEqual(["a file\nwith spaces.md"])
    expect(proposed.snapshot.diff).toContain("+candidate")
    const input = {
      sourceRepoId: "p/station",
      targetRepoId: "p/train",
      fromCommit: train.headCommit,
      toCommit: proposed.commit,
    }
    await f.host.fastForward(input)
    await f.host.fastForward(input)
    expect(await f.head("p/train")).toBe(proposed.commit)
    expect(await f.head("p/terminus")).toBe(terminus.headCommit)
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
    const baseline = await f.host.createTerminus({ namespace: "p" })
    const input = {
      sourceRepoId: "p/terminus",
      commit: baseline.headCommit,
      name: "train",
    }
    const train = await f.host.fork(input)
    await f.change("p/terminus")
    expect(await f.host.fork(input)).toEqual(train)
    expect(f.tokens.size).toBe(0)
  })

  it("revokes tokens when opening a workspace fails", async () => {
    const f = await fixture()
    f.workspaces.open = async () => {
      throw new Error("Sandbox unavailable")
    }
    await expect(f.host.createTerminus({ namespace: "p" })).rejects.toThrow(
      "Sandbox unavailable"
    )
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("revokes the server-issued fork token even if its source workspace shutdown fails", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ namespace: "p" })
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
        sourceRepoId: "p/terminus",
        commit: baseline.headCommit,
        name: "train",
      })
    ).rejects.toThrow("cleanup failed")
    expect(f.tokens.size).toBe(0)
  })

  it("refuses a fork when the source moved from the requested commit", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    await f.change("p/terminus")
    await expect(
      f.host.fork({
        sourceRepoId: "p/terminus",
        commit: terminus.headCommit,
        name: "train",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.repos.has("p/train")).toBe(false)
    expect(f.tokens.size).toBe(0)
  })

  it("detects a source moving during a server-side fork", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    f.setBeforeFork(async () => {
      await f.change("p/terminus")
    })
    await expect(
      f.host.fork({
        sourceRepoId: "p/terminus",
        commit: terminus.headCommit,
        name: "train",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.tokens.size).toBe(0)
  })

  it("refuses to overwrite a Train that has moved", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: terminus.headCommit,
      name: "train",
    })
    await f.host.fork({
      sourceRepoId: "p/train",
      commit: terminus.headCommit,
      name: "station",
    })
    const proposed = await f.change("p/station", "proposal.md")
    const other = await f.change("p/train", "technician.md")
    await expect(
      f.host.fastForward({
        sourceRepoId: "p/station",
        targetRepoId: "p/train",
        fromCommit: terminus.headCommit,
        toCommit: proposed.commit,
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(await f.head("p/train")).toBe(other.commit)
    expect(f.tokens.size).toBe(0)
  })

  it("rejects a Train advancing to an ancestor of the proposal between preflight and push", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ namespace: "p" })
    await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: baseline.headCommit,
      name: "train",
    })
    await f.host.fork({
      sourceRepoId: "p/train",
      commit: baseline.headCommit,
      name: "station",
    })
    const first = await f.change("p/station", "one.md")
    const second = await f.change("p/station", "two.md")
    f.setBeforePush(async () =>
      f.host.fastForward({
        targetRepoId: "p/train",
        sourceRepoId: "p/station",
        fromCommit: baseline.headCommit,
        toCommit: first.commit,
      })
    )
    await expect(
      f.host.fastForward({
        targetRepoId: "p/train",
        sourceRepoId: "p/station",
        fromCommit: baseline.headCommit,
        toCommit: second.commit,
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(await f.head("p/train")).toBe(first.commit)
    expect(f.tokens.size).toBe(0)
  })

  it("rejects validation that leaves uncommitted changes", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const access = await f.host.access("p/terminus", "write")
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
    const original = await f.host.createTerminus({ namespace: "original" })
    const changed = await f.change("original/terminus")
    const imported = await f.host.createTerminus({
      namespace: "imported",
      sourceUrl: (await f.repos.get("original/terminus")!.info()).remote,
    })
    expect(imported.repoId).toBe("imported/terminus")
    expect(imported.headCommit).toBe(changed.commit)
    expect(imported.headCommit).not.toBe(original.headCommit)
    expect(
      await f.host.createTerminus({
        namespace: "imported",
        sourceUrl: (await f.repos.get("original/terminus")!.info()).remote,
      })
    ).toEqual(imported)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("rejects an existing repository from a different fork operation", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const unrelated = await f.artifacts
      .namespace("p")
      .create("unrelated", { setDefaultBranch: "main", description: "Other" })
    f.tokens.delete(unrelated.token)
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

describe("Terminus merges with real Git", () => {
  async function setup() {
    const f = await fixture()
    await f.host.createTerminus({ namespace: "p" })
    const baseline = (await f.change("p/terminus", "shared.txt", "base\n"))
      .commit
    await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: baseline,
      name: "train",
    })
    const accepted = (await f.change("p/train", "train.txt", "accepted\n"))
      .commit
    const input = {
      id: "integration",
      terminusRepoId: "p/terminus",
      terminusCommit: baseline,
      trainRepoId: "p/train",
      trainCommit: accepted,
      trainBaseline: baseline,
      acceptedCommits: [accepted],
    }
    return { f, input }
  }

  it("merges against current Terminus and preserves both canonical and accepted history", async () => {
    const { f, input } = await setup()
    const current = (
      await f.change("p/terminus", "other.txt", "another Train\n")
    ).commit
    input.terminusCommit = current
    const prepared = await f.host.prepareIntegration(input)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error("Expected merge")
    const merge = prepared.candidate.headCommit
    const remote = (await f.repos.get(`p/${input.id}`)!.info()).remote
    expect(
      (
        await execute("git", [
          "--git-dir",
          remote,
          "show",
          "-s",
          "--format=%P",
          merge,
        ])
      ).stdout.trim()
    ).toBe(`${current} ${input.trainCommit}`)
    expect(
      (
        await execute("git", [
          "--git-dir",
          remote,
          "show",
          `${merge}:train.txt`,
        ])
      ).stdout
    ).toBe("accepted\n")
    expect(
      (
        await execute("git", [
          "--git-dir",
          remote,
          "show",
          `${merge}:other.txt`,
        ])
      ).stdout
    ).toBe("another Train\n")
    expect(await f.head("p/terminus")).toBe(current)
    expect(await f.head("p/train")).toBe(input.trainCommit)
    expect(await f.host.prepareIntegration(input)).toEqual(prepared)
    expect(f.grants.slice(-1)[0]!.map((access) => access.scope)).toEqual([
      "write",
      "read",
    ])
    await f.host.fastForward({
      targetRepoId: "p/terminus",
      sourceRepoId: `p/${input.id}`,
      fromCommit: current,
      toCommit: merge,
    })
    expect(await f.head("p/terminus")).toBe(merge)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("creates a merge commit even when the Train could fast-forward Terminus", async () => {
    const { f, input } = await setup()
    const result = await f.host.prepareIntegration(input)
    if (!result.ok) throw new Error("Expected merge")
    const remote = (await f.repos.get(`p/${input.id}`)!.info()).remote
    const parents = (
      await execute("git", [
        "--git-dir",
        remote,
        "show",
        "-s",
        "--format=%P",
        result.candidate.headCommit,
      ])
    ).stdout.trim()
    expect(parents).toBe(`${input.terminusCommit} ${input.trainCommit}`)
  })

  it("reports conflicting paths without changing Terminus or the Train", async () => {
    const { f, input } = await setup()
    input.trainCommit = (
      await f.change("p/train", "shared.txt", "Train changed\n")
    ).commit
    input.acceptedCommits.push(input.trainCommit)
    input.terminusCommit = (
      await f.change("p/terminus", "shared.txt", "Canonical changed\n")
    ).commit
    expect(await f.host.prepareIntegration(input)).toEqual({
      ok: false,
      conflictPaths: ["shared.txt"],
    })
    expect(await f.head("p/terminus")).toBe(input.terminusCommit)
    expect(await f.head("p/train")).toBe(input.trainCommit)
    expect(f.tokens.size).toBe(0)
  })

  it("recovers the same merge after candidate push succeeded but cleanup lost its response", async () => {
    const { f, input } = await setup()
    const open = f.workspaces.open.bind(f.workspaces)
    let lose = false
    f.workspaces.open = async (access) => {
      const workspace = await open(access)
      return {
        ...workspace,
        close: async () => {
          await workspace.close()
          if (lose) {
            lose = false
            throw new Error("Lost response")
          }
        },
      }
    }
    f.setBeforePush(async () => {
      lose = true
    })
    await expect(f.host.prepareIntegration(input)).rejects.toThrow(
      "cleanup failed"
    )
    const saved = await f.head(`p/${input.id}`)
    const retry = await f.host.prepareIntegration(input)
    expect(retry).toEqual({
      ok: true,
      candidate: { repoId: `p/${input.id}`, headCommit: saved },
    })
    expect(f.tokens.size).toBe(0)
  })

  it("refuses a second promotion prepared against an old canonical head", async () => {
    const { f, input } = await setup()
    await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: input.terminusCommit,
      name: "train-two",
    })
    const second = (await f.change("p/train-two", "two.txt")).commit
    const one = await f.host.prepareIntegration(input)
    const two = await f.host.prepareIntegration({
      ...input,
      id: "integration-two",
      trainRepoId: "p/train-two",
      trainCommit: second,
      acceptedCommits: [second],
    })
    if (!one.ok || !two.ok) throw new Error("Expected merges")
    await f.host.fastForward({
      targetRepoId: "p/terminus",
      sourceRepoId: `p/${input.id}`,
      fromCommit: input.terminusCommit,
      toCommit: one.candidate.headCommit,
    })
    await expect(
      f.host.fastForward({
        targetRepoId: "p/terminus",
        sourceRepoId: "p/integration-two",
        fromCommit: input.terminusCommit,
        toCommit: two.candidate.headCommit,
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(await f.head("p/terminus")).toBe(one.candidate.headCommit)
  })

  it("rejects missing accepted history before constructing a candidate", async () => {
    const { f, input } = await setup()
    const unrelated = await f.host.createTerminus({ namespace: "unrelated" })
    await expect(
      f.host.prepareIntegration({
        ...input,
        acceptedCommits: [unrelated.headCommit],
      })
    ).rejects.toThrow("ancestry")
    expect(await f.head("p/terminus")).toBe(input.terminusCommit)
  })
})
