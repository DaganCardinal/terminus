import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RepositoryHost } from "@terminus/artifacts"
import type { RepositoryOverview } from "@terminus/protocol"
import { cacheOverviews } from "./overview-cache"

const repoId = "project-a/terminus"
const first = "a".repeat(40)
const second = "b".repeat(40)

afterEach(async () => {
  await env.DB.exec("DELETE FROM repository_overviews")
})

function overview(commit: string, readme = "# Hello"): RepositoryOverview {
  return {
    commit,
    files: [{ path: "README.md", size: readme.length }],
    filesTruncated: false,
    documents: [{ path: "README.md", content: readme, truncated: false }],
  }
}

function host(read: (repoId: string, commit: string) => RepositoryOverview) {
  const readOverview = vi.fn(async (repoId: string, commit: string) =>
    read(repoId, commit)
  )
  return {
    host: { readOverview } as unknown as RepositoryHost,
    readOverview,
  }
}

describe("cacheOverviews", () => {
  it("reads each commit from the repository once", async () => {
    const { host: repositories, readOverview } = host((_, commit) =>
      overview(commit)
    )
    cacheOverviews(repositories, env.DB)

    expect(await repositories.readOverview(repoId, first)).toEqual(
      overview(first)
    )
    expect(await repositories.readOverview(repoId, first)).toEqual(
      overview(first)
    )
    expect(await repositories.readOverview(repoId, second)).toEqual(
      overview(second)
    )
    expect(readOverview.mock.calls).toEqual([
      [repoId, first],
      [repoId, second],
    ])
  })

  it("splits large overviews across rows and reassembles them", async () => {
    // Random text barely compresses, so it spans several small chunks.
    const readme = Array.from(crypto.getRandomValues(new Uint8Array(4000)))
      .map((byte) => byte.toString(36))
      .join("")
    const { host: repositories, readOverview } = host((_, commit) =>
      overview(commit, readme)
    )
    cacheOverviews(repositories, env.DB, 1024)

    await repositories.readOverview(repoId, first)
    const { results } = await env.DB.prepare(
      "SELECT chunk, chunks FROM repository_overviews ORDER BY chunk"
    ).all<{ chunk: number; chunks: number }>()
    expect(results.length).toBeGreaterThan(1)
    expect(results.every((row) => row.chunks === results.length)).toBe(true)

    expect(await repositories.readOverview(repoId, first)).toEqual(
      overview(first, readme)
    )
    expect(readOverview).toHaveBeenCalledTimes(1)
  })

  it("keeps failed reads out of the cache", async () => {
    let fail = true
    const { host: repositories, readOverview } = host((_, commit) => {
      if (fail) throw new Error("Sandbox unavailable")
      return overview(commit)
    })
    cacheOverviews(repositories, env.DB)

    await expect(repositories.readOverview(repoId, first)).rejects.toThrow(
      "Sandbox unavailable"
    )
    fail = false
    expect(await repositories.readOverview(repoId, first)).toEqual(
      overview(first)
    )
    expect(readOverview).toHaveBeenCalledTimes(2)
  })

  it("records each overview under its repository's namespace", async () => {
    const { host: repositories } = host((_, commit) => overview(commit))
    cacheOverviews(repositories, env.DB)

    await repositories.readOverview(repoId, first)
    await repositories.readOverview("project-b/terminus", first)
    const { results } = await env.DB.prepare(
      "SELECT namespace FROM repository_overviews ORDER BY namespace"
    ).all<{ namespace: string }>()
    expect(results.map((row) => row.namespace)).toEqual([
      "project-a",
      "project-b",
    ])
  })
})
