import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
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
import { ArtifactsApiError } from "./artifacts-rest"
import type { CommittedObjects } from "./repository-browse"
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

// Stands in for the Artifacts REST object endpoints: real objects, no workspace.
function gitObjects(gitDir: string): CommittedObjects {
  const read = async (args: string[]) =>
    (
      await execute("git", ["--git-dir", gitDir, ...args], {
        encoding: "buffer",
        maxBuffer: 10_000_000,
      })
    ).stdout
  return {
    treeOf: async (commit) =>
      (await read(["rev-parse", "--verify", `${commit}^{tree}`]))
        .toString()
        .trim(),
    tree: async (hash) =>
      (await read(["ls-tree", "-z", hash]))
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t") as [string, string]
          const [mode, type, object] = meta.split(" ") as [
            string,
            "blob" | "tree" | "commit",
            string,
          ]
          return { name, mode, type, hash: object }
        }),
    blobSize: async (hash) =>
      Number((await read(["cat-file", "-s", hash])).toString()),
    blob: async (hash) =>
      new Response(await read(["cat-file", "blob", hash])).body!,
  }
}

async function fixture(
  options: { readHeadDirectly?: boolean; readObjectsDirectly?: boolean } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "terminus-git-test-"))
  temporary.push(directory)
  const repos = new Map<string, ArtifactsRepository>()
  const tokens = new Set<string>()
  const handles = new Set<symbol>()
  const grants: RepositoryAccess[][] = []
  const namespaces = new Set<string>()
  let lookupError: unknown = null
  let pauses = 0
  let afterPause: (() => void) | null = null
  let beforeFork: (() => Promise<void>) | null = null
  let beforePush: (() => Promise<void>) | null = null
  let beforeToken: (() => Promise<void>) | null = null
  let lookups = 0
  const commands: string[][] = []
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
        await beforeToken?.()
        const id = issue()
        return { id, plaintext: id }
      },
      revokeToken: async (id) => tokens.delete(id),
      delete: async () => {
        repos.delete(id)
        await rm(remote, { recursive: true, force: true })
      },
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
        lookups++
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
      revokeToken: async (id) => tokens.delete(id),
      create: (name, options) =>
        create(`${namespace}/${name}`, options.description),
      import: (input) =>
        create(
          `${namespace}/${input.target.name}`,
          "Imported",
          input.source.url
        ),
      ...(options.readObjectsDirectly && {
        objects: (name: string) =>
          gitObjects(join(directory, `${namespace}--${name}.git`)),
      }),
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
          commands.push(command)
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
  // Stands in for smart-HTTP ref discovery: real refs, no workspace.
  const readHead = async (access: RepositoryAccess) =>
    (
      await execute("git", [
        "ls-remote",
        "--",
        access.remote,
        `refs/heads/${access.branch}`,
      ])
    ).stdout.split(/\s+/)[0] || null
  const host = new ArtifactsRepositoryHost(
    artifacts,
    workspaces,
    async () => {
      pauses++
      afterPause?.()
    },
    options.readHeadDirectly ? readHead : undefined
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
    commands,
    lookups: () => lookups,
    setLookupError: (error: unknown) => {
      lookupError = error
    },
    pauses: () => pauses,
    setAfterPause: (callback: (() => void) | null) => {
      afterPause = callback
    },
    setBeforePush: (callback: () => Promise<void>) => {
      beforePush = callback
    },
    setBeforeFork: (callback: () => Promise<void>) => {
      beforeFork = callback
    },
    setBeforeToken: (callback: (() => Promise<void>) | null) => {
      beforeToken = callback
    },
  }
}

describe("Artifacts repository transport with real Git", () => {
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

  it("waits out Artifacts' transient 403 (api 10004) on a repository read", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const denial = new ArtifactsApiError(403, "INTERNAL_ERROR", "Denied", {
      apiCode: 10004,
    })
    f.setLookupError(denial)
    let cleared = 0
    f.setAfterPause(() => {
      // The third backoff (four pauses) ends the refusal.
      if (++cleared === 1 + 2 + 4) f.setLookupError(null)
    })
    const access = await f.host.access(terminus.repoId, "read")
    expect(access.repoId).toBe("p/terminus")
    expect(f.pauses()).toBe(7)
    await f.host.revoke(access)
  })

  it("gives up on a 403 after about a minute, and never waits out other 403s", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const denial = new ArtifactsApiError(403, "INTERNAL_ERROR", "Denied", {
      apiCode: 10004,
    })
    f.setLookupError(denial)
    await expect(f.host.access(terminus.repoId, "read")).rejects.toBe(denial)
    // 1 + 2 + 4 + 8 × 7 pauses of one second each.
    expect(f.pauses()).toBe(63)

    const other = new ArtifactsApiError(403, "INTERNAL_ERROR", "Denied", {
      apiCode: 10000,
    })
    f.setLookupError(other)
    await expect(f.host.access(terminus.repoId, "read")).rejects.toBe(other)
    expect(f.pauses()).toBe(63)
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

  it("forks and reads heads without opening a workspace when heads are read directly", async () => {
    const f = await fixture({ readHeadDirectly: true })
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const opened = f.grants.length
    const train = await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: terminus.headCommit,
      name: "train",
    })
    expect(train).toEqual({
      repoId: "p/train",
      headCommit: terminus.headCommit,
    })
    expect(await f.host.head("p/train")).toBe(terminus.headCommit)
    expect(f.grants).toHaveLength(opened)
    expect(f.tokens.size).toBe(0)

    await f.change("p/terminus")
    await expect(
      f.host.fork({
        sourceRepoId: "p/terminus",
        commit: terminus.headCommit,
        name: "late",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.repos.has("p/late")).toBe(false)
    expect(f.tokens.size).toBe(0)
  })

  it("reads a head with one repository lookup, revoking its token without another", async () => {
    const f = await fixture({ readHeadDirectly: true })
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const before = f.lookups()
    expect(await f.host.head("p/terminus")).toBe(terminus.headCommit)
    expect(f.lookups() - before).toBe(1)
    expect(f.tokens.size).toBe(0)
  })

  it("confirms a reviewed repair from repository heads alone, and refuses moved ones", async () => {
    const f = await fixture({ readHeadDirectly: true })
    const terminus = await f.host.createTerminus({ namespace: "p" })
    for (const name of ["train", "repair"])
      await f.host.fork({
        sourceRepoId: "p/terminus",
        commit: terminus.headCommit,
        name,
      })
    const trainCommit = (await f.change("p/train")).commit
    const candidate = {
      repoId: "p/repair",
      headCommit: (await f.change("p/repair")).commit,
    }
    const input = {
      id: "repair",
      scope: ["README.md"],
      source: {
        integrationId: "failed",
        trainId: "train",
        trainRepoId: "p/train",
        trainCommit,
        trainBaseline: terminus.headCommit,
        terminusRepoId: "p/terminus",
        terminusCommit: terminus.headCommit,
        acceptedCommits: [trainCommit],
      },
    }
    const opened = f.grants.length
    await f.host.confirmRepair(input, candidate)
    expect(f.grants).toHaveLength(opened)
    expect(f.tokens.size).toBe(0)

    await f.change("p/repair", "README.md", "changed after review\n")
    await expect(f.host.confirmRepair(input, candidate)).rejects.toThrow(
      "reviewed candidate"
    )
    await f.change("p/train", "README.md", "moved\n")
    await expect(f.host.confirmRepair(input, candidate)).rejects.toThrow(
      "Train moved"
    )
    expect(f.tokens.size).toBe(0)
  })

  it("reads exact historical comparisons from Artifacts objects without a workspace or token", async () => {
    const f = await fixture({ readObjectsDirectly: true })
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const first = await f.change(
      terminus.repoId,
      "README.md",
      "first accepted change\n"
    )
    await f.change(terminus.repoId, "README.md", "later accepted change\n")
    const opened = f.grants.length
    const files = await f.host.readChanges(
      terminus.repoId,
      terminus.headCommit,
      first.commit
    )
    expect(files.files.map((file) => file.path)).toEqual(["README.md"])
    const patch = await f.host.readChangeFile(
      terminus.repoId,
      terminus.headCommit,
      first.commit,
      "README.md"
    )
    expect(patch?.hunks.flatMap((hunk) => hunk.lines)).toContain(
      "+first accepted change"
    )
    expect(patch?.hunks.flatMap((hunk) => hunk.lines)).not.toContain(
      "+later accepted change"
    )
    expect(f.grants).toHaveLength(opened)
    expect(f.tokens.size).toBe(0)
  })

  it("reads files from objects by the same rules as a workspace, without opening one", async () => {
    const f = await fixture({ readObjectsDirectly: true })
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const work = await mkdtemp(join(tmpdir(), "terminus-files-test-"))
    temporary.push(work)
    const remote = (await f.repos.get("p/terminus")!.info()).remote
    const g = (...args: string[]) =>
      execute("git", [
        "-C",
        work,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        ...args,
      ])
    await execute("git", ["clone", "--", remote, work])
    await mkdir(join(work, "src/lib"), { recursive: true })
    await writeFile(join(work, "README.md"), "# Demo\n")
    await writeFile(join(work, "src/lib/util.ts"), "export const x = 1\n")
    await writeFile(join(work, "run.sh"), "#!/bin/sh\n", { mode: 0o755 })
    await writeFile(join(work, ".env"), "SECRET=1\n")
    await symlink(".env", join(work, "notes.txt"))
    await writeFile(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0, 1]))
    await writeFile(join(work, "big.txt"), "é".repeat(400_001))
    await g("add", "-A")
    await g(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${terminus.headCommit},vendor/lib`
    )
    await g("commit", "-m", "Files")
    await g("push", "origin", "HEAD:main")
    const commit = (await g("rev-parse", "HEAD")).stdout.trim()
    const viaWorkspace = new ArtifactsRepositoryHost(
      {
        ensure: f.artifacts.ensure,
        namespace: (namespace) => ({
          ...f.artifacts.namespace(namespace),
          objects: undefined,
        }),
      },
      f.workspaces,
      async () => {}
    )

    const paths = [
      "README.md",
      "src/lib/util.ts",
      "run.sh",
      "logo.png",
      "big.txt",
      ".env",
      "notes.txt",
      "vendor/lib",
      "src",
      "src/lib",
      "README.md/x",
      "missing.md",
    ]
    const expected = await Promise.all(
      paths.map((path) => viaWorkspace.readFile("p/terminus", commit, path))
    )
    expect(expected[0]?.content).toBe("# Demo\n")
    const opened = f.grants.length
    for (const [index, path] of paths.entries())
      expect(await f.host.readFile("p/terminus", commit, path), path).toEqual(
        expected[index]
      )
    const big = await f.host.readFile("p/terminus", commit, "big.txt")
    expect(big).toMatchObject({ size: 800_002, truncated: true })
    expect(big?.content).toHaveLength(400_000)
    expect(
      await f.host.readFile("p/terminus", commit, "logo.png")
    ).toMatchObject({ size: 4, content: null })
    expect(await f.host.readFile("p/terminus", commit, "notes.txt")).toBeNull()
    for (const path of ["/README.md", "src//lib/util.ts", "src/lib/"])
      expect(await f.host.readFile("p/terminus", commit, path)).toBeNull()
    await expect(
      f.host.readFile("p/terminus", "0".repeat(40), "README.md")
    ).rejects.toThrow()
    await expect(
      f.host.readFile("p/terminus", "main", "README.md")
    ).rejects.toThrow("Expected a full Git commit identity")
    expect(f.grants).toHaveLength(opened)
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

  it.each([false, true])(
    "refuses to overwrite a Train that has moved (Worker head reads: %s)",
    async (readHeadDirectly) => {
      const f = await fixture({ readHeadDirectly })
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
    }
  )

  it.each([false, true])(
    "rejects a Train advancing to an ancestor of the proposal between preflight and push (Worker head reads: %s)",
    async (readHeadDirectly) => {
      const f = await fixture({ readHeadDirectly })
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
    }
  )

  it("fast-forwards with Worker head reads and a shell-installed guard, running neither ls-remote nor Node", async () => {
    const f = await fixture({ readHeadDirectly: true })
    const baseline = await f.host.createTerminus({ namespace: "p" })
    for (const [name, source] of [
      ["train", "p/terminus"],
      ["station", "p/train"],
    ] as const)
      await f.host.fork({
        sourceRepoId: source,
        commit: baseline.headCommit,
        name,
      })
    const proposed = await f.change("p/station", "proposal.md")
    const input = {
      sourceRepoId: "p/station",
      targetRepoId: "p/train",
      fromCommit: baseline.headCommit,
      toCommit: proposed.commit,
    }
    const ran = f.commands.length
    await f.host.fastForward(input)
    expect(await f.head("p/train")).toBe(proposed.commit)
    expect(
      f.commands
        .slice(ran)
        .map(([program, subcommand]) =>
          program === "git" ? `git ${subcommand}` : program
        )
    ).toEqual(["git clone", "git merge-base", "sh", "git push"])
    // A retry after a lost response finds the Train already there.
    const retried = f.commands.length
    await f.host.fastForward(input)
    expect(f.commands).toHaveLength(retried)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("mints a workspace's credentials together, and revokes them when one is refused", async () => {
    const f = await fixture()
    const baseline = await f.host.createTerminus({ namespace: "p" })
    await f.host.fork({
      sourceRepoId: "p/terminus",
      commit: baseline.headCommit,
      name: "train",
    })
    const advanced = (await f.change("p/terminus", "next.md")).commit
    let minting = 0
    let most = 0
    f.setBeforeToken(async () => {
      most = Math.max(most, ++minting)
      await new Promise((resolve) => setTimeout(resolve, 10))
      minting--
    })
    await f.host.fastForward({
      sourceRepoId: "p/terminus",
      targetRepoId: "p/train",
      fromCommit: baseline.headCommit,
      toCommit: advanced,
    })
    expect(most).toBe(2)
    f.setBeforeToken(null)
    expect(await f.head("p/train")).toBe(advanced)

    const grants = f.grants.length
    await expect(
      f.host.fastForward({
        sourceRepoId: "p/missing",
        targetRepoId: "p/train",
        fromCommit: advanced,
        toCommit: advanced,
      })
    ).rejects.toThrow("missing")
    expect(f.grants).toHaveLength(grants)
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

  it("forks a new Train's first Station from Terminus while both are at the same commit", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const train = await f.host.fork({
      sourceRepoId: terminus.repoId,
      commit: terminus.headCommit,
      name: "train",
    })
    const input = {
      sourceRepoId: train.repoId,
      commit: train.headCommit,
      name: "station",
      preferredSourceRepoId: terminus.repoId,
    }
    const station = await f.host.fork(input)
    expect(station).toEqual({
      repoId: "p/station",
      headCommit: terminus.headCommit,
    })
    expect((await f.repos.get("p/station")!.info()).description).toBe(
      `Terminus fork: p/terminus@${terminus.headCommit}`
    )
    // A retry reuses it, even once Terminus has moved on.
    await f.change("p/terminus")
    expect(await f.host.fork(input)).toEqual(station)
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("forks the source when the preferred source is no longer at the commit", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const train = await f.host.fork({
      sourceRepoId: terminus.repoId,
      commit: terminus.headCommit,
      name: "train",
    })
    await f.change("p/terminus")
    expect(
      await f.host.fork({
        sourceRepoId: train.repoId,
        commit: train.headCommit,
        name: "station",
        preferredSourceRepoId: terminus.repoId,
      })
    ).toEqual({ repoId: "p/station", headCommit: train.headCommit })
    expect((await f.repos.get("p/station")!.info()).description).toBe(
      `Terminus fork: p/train@${train.headCommit}`
    )
    expect(f.tokens.size).toBe(0)
  })

  it("replaces a preferred-source fork that missed the commit with a fork of the source", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    const train = await f.host.fork({
      sourceRepoId: terminus.repoId,
      commit: terminus.headCommit,
      name: "train",
    })
    let moved = false
    f.setBeforeFork(async () => {
      if (moved) return
      moved = true
      await f.change("p/terminus")
    })
    expect(
      await f.host.fork({
        sourceRepoId: train.repoId,
        commit: train.headCommit,
        name: "station",
        preferredSourceRepoId: terminus.repoId,
      })
    ).toEqual({ repoId: "p/station", headCommit: train.headCommit })
    expect(await f.head("p/station")).toBe(train.headCommit)
    expect((await f.repos.get("p/station")!.info()).description).toBe(
      `Terminus fork: p/train@${train.headCommit}`
    )
    expect(f.tokens.size).toBe(0)
    expect(f.handles.size).toBe(0)
  })

  it("never replaces a fork of the source itself that missed the commit", async () => {
    const f = await fixture()
    const terminus = await f.host.createTerminus({ namespace: "p" })
    f.setBeforeFork(async () => {
      await f.change("p/terminus")
    })
    await expect(
      f.host.fork({
        sourceRepoId: terminus.repoId,
        commit: terminus.headCommit,
        name: "train",
        preferredSourceRepoId: "p/elsewhere",
      })
    ).rejects.toBeInstanceOf(RepositoryMovedError)
    expect(f.repos.has("p/train")).toBe(true)
    expect(f.tokens.size).toBe(0)
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
