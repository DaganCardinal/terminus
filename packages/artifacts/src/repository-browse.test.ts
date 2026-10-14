import { describe, expect, it, vi } from "vitest"
import {
  documentRank,
  isDocumentPath,
  isSecretPath,
  readCommittedOverview,
  type CommittedObjects,
  type CommittedTreeEntry,
} from "./repository-browse"

describe("repository browsing", () => {
  it("treats prose as documents and skips vendored trees", () => {
    expect(isDocumentPath("README.md")).toBe(true)
    expect(isDocumentPath("LICENSE")).toBe(true)
    expect(isDocumentPath("docs/guide.mdx")).toBe(true)
    expect(isDocumentPath("src/App.tsx")).toBe(false)
    expect(isDocumentPath("node_modules/pkg/README.md")).toBe(false)
  })

  it("ranks documents the way a newcomer reads them", () => {
    const paths = [
      "src/lib/README.md",
      "docs/setup.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "AGENTS.md",
      "README.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ]
    expect(paths.sort((a, b) => documentRank(a) - documentRank(b))).toEqual([
      "README.md",
      "AGENTS.md",
      "LICENSE",
      "CONTRIBUTING.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "docs/setup.md",
      "src/lib/README.md",
    ])
  })

  it("never exposes credential files", () => {
    expect(isSecretPath(".env.local")).toBe(true)
    expect(isSecretPath("config/server.pem")).toBe(true)
    expect(isSecretPath(".dev.vars")).toBe(true)
    expect(isSecretPath("src/env.ts")).toBe(false)
  })
})

describe("committed repository overviews", () => {
  const commit = "a".repeat(40)
  const blob = (
    name: string,
    hash = name,
    mode = "100644"
  ): CommittedTreeEntry => ({ name, hash, mode, type: "blob" })
  const tree = (name: string): CommittedTreeEntry => ({
    name,
    hash: name,
    mode: "040000",
    type: "tree",
  })
  function objects(
    trees: Record<string, CommittedTreeEntry[]>
  ): CommittedObjects {
    return {
      treeOf: vi.fn(async () => "root"),
      tree: vi.fn(async (hash) => trees[hash] ?? []),
      blobSize: vi.fn(async () => 2),
      blob: vi.fn(async () => new Response("ok").body!),
    }
  }

  it("keeps the first 5,000 sorted files and the top 40 documents, reusing blob sizes", async () => {
    const reader = objects({
      root: [
        tree("src"),
        tree("docs"),
        blob("README.md"),
        blob(".env"),
        blob("link.md", "link", "120000"),
        { name: "submodule", hash: "module", mode: "160000", type: "commit" },
      ],
      src: Array.from({ length: 5001 }, (_, i) =>
        blob(`${String(i).padStart(4, "0")}.ts`, "shared")
      ).reverse(),
      docs: Array.from({ length: 41 }, (_, i) =>
        blob(`${String(i).padStart(2, "0")}.md`)
      ),
    })
    const overview = await readCommittedOverview(reader, commit)
    expect(overview.files).toHaveLength(5000)
    expect(overview.filesTruncated).toBe(true)
    expect(overview.files.map((file) => file.path)).toEqual(
      [
        "README.md",
        ...Array.from(
          { length: 41 },
          (_, i) => `docs/${String(i).padStart(2, "0")}.md`
        ),
        ...Array.from(
          { length: 4958 },
          (_, i) => `src/${String(i).padStart(4, "0")}.ts`
        ),
      ].sort((a, b) => a.localeCompare(b))
    )
    expect(overview.documents.map((document) => document.path)).toEqual([
      "README.md",
      ...Array.from(
        { length: 39 },
        (_, i) => `docs/${String(i).padStart(2, "0")}.md`
      ),
    ])
    expect(reader.blobSize).toHaveBeenCalledTimes(43)
    expect(reader.blob).toHaveBeenCalledTimes(40)
  })

  it("bounds simultaneous size reads and truncates document streams", async () => {
    const reader = objects({
      root: Array.from({ length: 10 }, (_, i) => blob(`${i}.txt`)),
    })
    let active = 0,
      most = 0
    reader.blobSize = async () => {
      most = Math.max(most, ++active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return 200_001
    }
    const cancelled = vi.fn()
    reader.blob = async () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("é".repeat(200_001)))
        },
        cancel: cancelled,
      })
    const overview = await readCommittedOverview(reader, commit)
    expect(most).toBe(4)
    expect(overview.filesTruncated).toBe(false)
    expect(
      overview.documents.every(
        (doc) => doc.truncated && doc.content.length === 200_000
      )
    ).toBe(true)
    expect(cancelled).toHaveBeenCalledTimes(10)
  })

  it("caps tree reads and directory depth, reporting incomplete inventory", async () => {
    const reader = objects({
      root: Array.from({ length: 1001 }, (_, i) => tree(`dir-${i}`)),
    })
    expect((await readCommittedOverview(reader, commit)).filesTruncated).toBe(
      true
    )
    expect(reader.tree).toHaveBeenCalledTimes(1000)
    const deep = objects({})
    deep.tree = vi.fn(async () => [tree("nested")])
    expect((await readCommittedOverview(deep, commit)).filesTruncated).toBe(
      true
    )
    expect(deep.tree).toHaveBeenCalledTimes(65)
  })

  it("refuses non-commit identities and invalid tree paths before reading blobs", async () => {
    const reader = objects({ root: [blob("../secret")] })
    await expect(readCommittedOverview(reader, "main")).rejects.toThrow(
      "full Git commit"
    )
    expect(reader.treeOf).not.toHaveBeenCalled()
    await expect(readCommittedOverview(reader, commit)).rejects.toThrow(
      "invalid tree path"
    )
    expect(reader.blob).not.toHaveBeenCalled()
  })
})
