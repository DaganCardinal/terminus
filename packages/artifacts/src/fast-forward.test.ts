import { execFile, spawn } from "node:child_process"
import * as fs from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { HttpClient } from "isomorphic-git"
import { promoteFastForward } from "./fast-forward"
import { RepositoryMovedError, type RepositoryAccess } from "./git"

const exec = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "terminus-promotion-test-"))
  temporary.push(dir)
  const work = join(dir, "work")
  const sourceDir = join(dir, "source.git")
  const targetDir = join(dir, "target.git")
  const git = async (...args: string[]) =>
    (await exec("git", args)).stdout.trim()
  const g = (...args: string[]) => git("-C", work, ...args)
  await git("init", "-b", "main", work)
  await g("config", "user.name", "Test")
  await g("config", "user.email", "test@localhost")
  await writeFile(join(work, "README.md"), "baseline\n")
  await g("add", ".")
  await g("commit", "-m", "Baseline")
  const base = await g("rev-parse", "HEAD")
  await git("clone", "--bare", work, targetDir)
  await writeFile(join(work, "README.md"), "accepted\n")
  await g("commit", "-am", "Accepted")
  const first = await g("rev-parse", "HEAD")
  await writeFile(join(work, "later.txt"), "later work\n")
  await g("add", ".")
  await g("commit", "-m", "Later")
  const second = await g("rev-parse", "HEAD")
  await git("clone", "--bare", work, sourceDir)
  await git("--git-dir", targetDir, "config", "http.receivepack", "true")
  const access = (
    name: string,
    scope: RepositoryAccess["scope"]
  ): RepositoryAccess => ({
    repoId: `p/${name}`,
    remote: `https://artifacts.test/${name}.git`,
    branch: "main",
    token: `${name}-secret`,
    tokenId: name,
    scope,
  })
  const source = access("source", "read"),
    target = access("target", "write")
  const calls: string[] = []
  let beforeAdvertisement: (() => Promise<void>) | undefined
  let beforeWrite: (() => Promise<void>) | undefined
  let loseAcknowledgement = false
  const http: HttpClient = {
    request: async ({ url, method = "GET", body, headers = {} }) => {
      const requested = new URL(url)
      calls.push(`${method} ${requested.pathname}${requested.search}`)
      if (requested.search === "?service=git-receive-pack")
        await beforeAdvertisement?.()
      if (requested.pathname.endsWith("/git-receive-pack"))
        await beforeWrite?.()
      const chunks: Uint8Array[] = []
      if (body) for await (const chunk of body) chunks.push(chunk)
      const input = Buffer.concat(chunks)
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const process = spawn("git", ["http-backend"], {
          env: {
            ...globalThis.process.env,
            GIT_PROJECT_ROOT: dir,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: requested.pathname,
            QUERY_STRING: requested.search.slice(1),
            REQUEST_METHOD: method,
            CONTENT_TYPE:
              headers["Content-Type"] ?? headers["content-type"] ?? "",
            CONTENT_LENGTH: String(input.length),
            REMOTE_USER: "terminus",
          },
        })
        const output: Buffer[] = []
        process.stdout.on("data", (chunk: Buffer) => output.push(chunk))
        process.on("error", reject)
        process.on("close", (code) =>
          code === 0
            ? resolve(Buffer.concat(output))
            : reject(new Error(`Git HTTP backend failed (${code})`))
        )
        process.stdin.end(input)
      })
      if (
        loseAcknowledgement &&
        requested.pathname.endsWith("/git-receive-pack")
      )
        throw new Error("Lost push acknowledgement")
      const split = raw.indexOf("\r\n\r\n")
      const responseHeaders = Object.fromEntries(
        raw
          .subarray(0, split)
          .toString()
          .split("\r\n")
          .map((line) => {
            const at = line.indexOf(":")
            return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]
          })
      )
      return {
        url,
        statusCode: Number(responseHeaders.status?.split(" ")[0] ?? 200),
        statusMessage: "OK",
        headers: responseHeaders,
        body: (async function* () {
          yield raw.subarray(split + 4)
        })(),
      }
    },
  }
  const readHead = async () => git("--git-dir", targetDir, "rev-parse", "main")
  const move = async (commit: string) => {
    // The race commits have to be present on the server, just as with another promotion.
    await git("--git-dir", targetDir, "fetch", sourceDir, commit)
    await git("--git-dir", targetDir, "update-ref", "refs/heads/main", commit)
  }
  const promote = (fromCommit = base, toCommit = first) =>
    promoteFastForward(
      { source, target, fromCommit, toCommit },
      { fs, http, dir: join(dir, `clone-${crypto.randomUUID()}`) },
      readHead
    )
  return {
    base,
    first,
    second,
    calls,
    git,
    targetDir,
    sourceDir,
    readHead,
    move,
    promote,
    beforeAdvertisement: (run: () => Promise<void>) => {
      beforeAdvertisement = run
    },
    beforeWrite: (run: () => Promise<void>) => {
      beforeWrite = run
    },
    loseAcknowledgement: () => {
      loseAcknowledgement = true
    },
  }
}

describe("isomorphic-git promotion against native Git smart HTTP", () => {
  it("pushes the exact accepted historical commit, preserving its identity and tree", async () => {
    const f = await fixture()
    await f.promote()
    expect(await f.readHead()).toBe(f.first)
    expect(
      await f.git("--git-dir", f.targetDir, "show", "main:README.md")
    ).toBe("accepted")
    expect(
      await f.git("--git-dir", f.targetDir, "show", "-s", "--format=%P", "main")
    ).toBe(f.base)
    expect(
      f.calls.some((call) => call.includes("source.git/git-receive-pack"))
    ).toBe(false)
    const calls = f.calls.length
    await f.promote()
    expect(f.calls).toHaveLength(calls)
  })

  it("refuses a moved target before cloning, and a candidate behind its target", async () => {
    const f = await fixture()
    await f.move(f.first)
    await expect(f.promote(f.base, f.second)).rejects.toBeInstanceOf(
      RepositoryMovedError
    )
    expect(f.calls).toEqual([])
    await expect(f.promote(f.first, f.base)).rejects.toThrow("not a descendant")
    expect(await f.readHead()).toBe(f.first)
  })

  it("preserves both integration merge parents and every accepted commit", async () => {
    const f = await fixture()
    const tree = await f.git(
      "--git-dir",
      f.sourceDir,
      "rev-parse",
      `${f.second}^{tree}`
    )
    const merge = await f.git(
      "--git-dir",
      f.sourceDir,
      "-c",
      "user.name=Terminus",
      "-c",
      "user.email=test@localhost",
      "commit-tree",
      tree,
      "-p",
      f.base,
      "-p",
      f.second,
      "-m",
      "Integration candidate"
    )
    await f.git(
      "--git-dir",
      f.sourceDir,
      "update-ref",
      "refs/heads/main",
      merge
    )
    await f.promote(f.base, merge)
    expect(await f.readHead()).toBe(merge)
    expect(
      await f.git("--git-dir", f.targetDir, "show", "-s", "--format=%P", "main")
    ).toBe(`${f.base} ${f.second}`)
    await f.git(
      "--git-dir",
      f.targetDir,
      "merge-base",
      "--is-ancestor",
      f.first,
      merge
    )
  })

  it("rejects an intermediate ancestor advertised after preflight", async () => {
    const f = await fixture()
    f.beforeAdvertisement(() => f.move(f.first))
    await expect(f.promote(f.base, f.second)).rejects.toBeInstanceOf(
      RepositoryMovedError
    )
    expect(await f.readHead()).toBe(f.first)
    expect(
      f.calls.some((call) =>
        call.startsWith("POST /target.git/git-receive-pack")
      )
    ).toBe(false)
  })

  it("lets the server reject an intervening write after advertisement", async () => {
    const f = await fixture()
    f.beforeWrite(() => f.move(f.first))
    await expect(f.promote(f.base, f.second)).rejects.toBeInstanceOf(
      RepositoryMovedError
    )
    expect(await f.readHead()).toBe(f.first)
  })

  it("recovers a successful push with a lost acknowledgement", async () => {
    const f = await fixture()
    f.loseAcknowledgement()
    await f.promote()
    expect(await f.readHead()).toBe(f.first)
  })
})
