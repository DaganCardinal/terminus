import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { RepositoryAccess } from "./git"
import { advertisedHead, smartHttpHeadReader } from "./smart-http"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

const access: RepositoryAccess = {
  repoId: "p/train",
  remote: "https://account.artifacts.cloudflare.net/git/p/train.git",
  branch: "main",
  token: "art_v1_secret?expires=1",
  tokenId: "token-1",
  scope: "read",
}

/** What Git's smart-HTTP endpoint serves for `info/refs`, from real Git. */
async function advertisement(
  setup: (repo: string) => Promise<string | null>
): Promise<{ body: Uint8Array; head: string | null }> {
  const directory = await mkdtemp(join(tmpdir(), "terminus-refs-test-"))
  temporary.push(directory)
  const repo = join(directory, "repo")
  await execute("git", ["init", "-q", "-b", "main", repo])
  const head = await setup(repo)
  const refs = await execute(
    "git",
    ["upload-pack", "--stateless-rpc", "--advertise-refs", join(repo, ".git")],
    { encoding: "buffer" }
  )
  const service = "# service=git-upload-pack\n"
  const prefix = `${(service.length + 4).toString(16).padStart(4, "0")}${service}0000`
  return {
    body: new Uint8Array([...Buffer.from(prefix), ...refs.stdout]),
    head,
  }
}

async function commit(repo: string, branch?: string): Promise<string> {
  if (branch)
    await execute("git", ["checkout", "-q", "-b", branch], { cwd: repo })
  await writeFile(join(repo, "file.txt"), `${branch ?? "main"}\n`)
  await execute("git", ["add", "."], { cwd: repo })
  await execute(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"],
    { cwd: repo }
  )
  return (
    await execute("git", ["rev-parse", "HEAD"], { cwd: repo })
  ).stdout.trim()
}

describe("smart-HTTP ref advertisement", () => {
  it("reads the requested branch head among other refs", async () => {
    const { body, head } = await advertisement(async (repo) => {
      const main = await commit(repo)
      await commit(repo, "feature")
      await execute("git", ["tag", "v1"], { cwd: repo })
      return main
    })
    expect(advertisedHead(body, "refs/heads/main")).toBe(head)
  })

  it("reports no head for an empty repository or a missing branch", async () => {
    const empty = await advertisement(async () => null)
    expect(advertisedHead(empty.body, "refs/heads/main")).toBeNull()
    const other = await advertisement(async (repo) => {
      await commit(repo)
      return null
    })
    expect(advertisedHead(other.body, "refs/heads/trunk")).toBeNull()
  })

  it("rejects malformed packet lines", () => {
    const encoder = new TextEncoder()
    expect(() =>
      advertisedHead(encoder.encode("zzzz"), "refs/heads/main")
    ).toThrow("Malformed")
    expect(() =>
      advertisedHead(encoder.encode("00ff0000"), "refs/heads/main")
    ).toThrow("Malformed")
  })

  it("asks the remote's info/refs with the repository token and reads its head", async () => {
    const { body, head } = await advertisement(commit)
    const requests: Request[] = []
    const read = smartHttpHeadReader(async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(body, {
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
        },
      })
    })
    expect(await read(access)).toBe(head)
    expect(requests[0]!.url).toBe(
      "https://account.artifacts.cloudflare.net/git/p/train.git/info/refs?service=git-upload-pack"
    )
    expect(requests[0]!.headers.get("authorization")).toBe(
      `Bearer ${access.token}`
    )
    expect(requests[0]!.redirect).toBe("manual")
  })

  it("refuses failed or non-smart responses and unsupported remotes", async () => {
    const respond = (response: Response) =>
      smartHttpHeadReader(async () => response)
    await expect(
      respond(new Response("denied", { status: 403 }))(access)
    ).rejects.toThrow("(403)")
    await expect(
      respond(new Response("ref: refs/heads/main", { status: 200 }))(access)
    ).rejects.toThrow("ref discovery failed")
    await expect(
      respond(new Response(""))({
        ...access,
        remote: "http://example.test/r.git",
      })
    ).rejects.toThrow("Unsupported Git remote")
  })
})
