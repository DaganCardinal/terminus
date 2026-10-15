import { describe, expect, it, vi } from "vitest"
import { applyPatch, formatPatch } from "diff"
import {
  readCommittedChanges,
  readCommittedChangeFile,
  readCommittedPatch,
} from "./repository-changes"
import type { CommittedObjects, CommittedTreeEntry } from "./repository-browse"
import { repositoryChangeFileSchema } from "@terminus/protocol"

const base = "a".repeat(40),
  head = "b".repeat(40)
const blob = (
  name: string,
  hash: string,
  mode = "100644"
): CommittedTreeEntry => ({ name, hash, mode, type: "blob" })
const directory = (name: string, hash: string): CommittedTreeEntry => ({
  name,
  hash,
  mode: "040000",
  type: "tree",
})

function objects(
  trees: Record<string, CommittedTreeEntry[]>,
  blobs: Record<string, string | Uint8Array> = {}
) {
  const bytes = (hash: string) =>
    typeof blobs[hash] === "string"
      ? new TextEncoder().encode(blobs[hash])
      : (blobs[hash] as Uint8Array)
  return {
    treeOf: vi.fn(async (commit: string) => (commit === base ? "old" : "new")),
    tree: vi.fn(async (hash: string) => {
      if (!trees[hash]) throw new Error(`Unexpected tree ${hash}`)
      return trees[hash]!
    }),
    blobSize: vi.fn(async (hash: string) => bytes(hash).length),
    blob: vi.fn(async (hash: string) => new Response(bytes(hash)).body!),
  } satisfies CommittedObjects
}

describe("on-demand committed changes", () => {
  it("lists adds, deletes and mode changes without reading blobs or unchanged subtrees", async () => {
    const store = objects({
      old: [
        directory("unchanged", "shared"),
        directory("src", "old-src"),
        blob("gone.txt", "gone"),
        blob("run.sh", "run", "100644"),
      ],
      new: [
        directory("unchanged", "shared"),
        directory("src", "new-src"),
        blob("run.sh", "run", "100755"),
        blob(".env.local", "secret"),
      ],
      "old-src": [blob("app.ts", "old-app")],
      "new-src": [
        blob("app.ts", "new-app"),
        blob("new.ts", "added"),
        blob("credentials.json", "secret"),
      ],
    })
    expect(await readCommittedChanges(store, base, head)).toEqual({
      base,
      head,
      filesTruncated: false,
      files: [
        {
          path: "gone.txt",
          kind: "deleted",
          beforeMode: "100644",
          afterMode: null,
        },
        {
          path: "run.sh",
          kind: "modified",
          beforeMode: "100644",
          afterMode: "100755",
        },
        {
          path: "src/app.ts",
          kind: "modified",
          beforeMode: "100644",
          afterMode: "100644",
        },
        {
          path: "src/new.ts",
          kind: "added",
          beforeMode: null,
          afterMode: "100644",
        },
      ],
    })
    expect(store.tree).not.toHaveBeenCalledWith("shared")
    expect(store.blob).not.toHaveBeenCalled()
    expect(store.blobSize).not.toHaveBeenCalled()
  })

  it("handles a file replaced by a directory and does not silently truncate inventories", async () => {
    const store = objects({
      old: [blob("src", "file")],
      new: [directory("src", "src")],
      src: [blob("app.ts", "app")],
    })
    const result = await readCommittedChanges(store, base, head)
    expect(result.files.map((file) => [file.path, file.kind])).toEqual([
      ["src", "deleted"],
      ["src/app.ts", "added"],
    ])
    expect(
      await readCommittedChangeFile(
        objects(
          { old: [blob("src", "file")], new: [directory("src", "src")] },
          { file: "contents\n" }
        ),
        base,
        head,
        "src"
      )
    ).toMatchObject({ file: { kind: "deleted" }, status: "text" })
    const huge = objects({
      old: [],
      new: Array.from({ length: 5001 }, (_, i) =>
        blob(`file-${i}`, `hash-${i}`)
      ),
    })
    const limited = await readCommittedChanges(huge, base, head)
    expect(limited.files).toHaveLength(5000)
    expect(limited.filesTruncated).toBe(true)
  })

  it("fetches only the selected file and produces patches that reconstruct each complete change", async () => {
    for (const [before, after] of [
      ["one\ntwo\n", "one\nthree\n"],
      ["", "added"],
      ["deleted\n", ""],
      ["no newline", "has newline\n"],
    ]) {
      const store = objects(
        {
          old: before ? [blob("app.ts", "before")] : [],
          new: after
            ? [blob("app.ts", "after"), blob("other.ts", "other")]
            : [],
        },
        { before: before!, after: after! }
      )
      const result = repositoryChangeFileSchema.parse(
        await readCommittedChangeFile(store, base, head, "app.ts")
      )
      expect(result.status).toBe("text")
      const patch = formatPatch({
        oldFileName: "app.ts",
        newFileName: "app.ts",
        oldHeader: "",
        newHeader: "",
        hunks: result.hunks,
      })
      expect(applyPatch(before!, patch)).toBe(after)
      expect(store.blob).not.toHaveBeenCalledWith("other")
    }
  })

  it("never loads secrets, symlink targets or oversized blobs; distinguishes binary changes", async () => {
    const store = objects(
      {
        old: [],
        new: [
          blob(".env", "secret"),
          blob("link", "secret", "120000"),
          blob("binary", "binary"),
          blob("large", "large"),
        ],
      },
      { binary: new Uint8Array([1, 0, 2]), large: "x".repeat(128001) }
    )
    expect(await readCommittedChangeFile(store, base, head, ".env")).toBeNull()
    expect(
      await readCommittedChangeFile(store, base, head, "link")
    ).toMatchObject({ status: "unsupported", hunks: [] })
    expect(
      await readCommittedChangeFile(store, base, head, "large")
    ).toMatchObject({ status: "too_large", hunks: [] })
    expect(
      await readCommittedChangeFile(store, base, head, "binary")
    ).toMatchObject({ status: "binary", hunks: [] })
    expect(store.blob.mock.calls.map(([hash]) => hash)).toEqual(["binary"])
  })

  it("detects invalid UTF-8, bounds complex comparisons, and keeps mode-only changes visible", async () => {
    const store = objects(
      {
        old: [blob("mode", "same")],
        new: [
          blob("mode", "same", "100755"),
          blob("invalid", "invalid"),
          blob("complex", "complex"),
        ],
      },
      {
        same: "same\n",
        invalid: new Uint8Array([0xff]),
        complex: Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n"),
      }
    )
    expect(
      await readCommittedChangeFile(store, base, head, "invalid")
    ).toMatchObject({ status: "binary" })
    expect(
      await readCommittedChangeFile(store, base, head, "complex")
    ).toMatchObject({ status: "too_large", hunks: [] })
    expect(
      await readCommittedChangeFile(store, base, head, "mode")
    ).toMatchObject({
      status: "text",
      hunks: [],
      file: { beforeMode: "100644", afterMode: "100755" },
    })
  })

  it("does no object reads for identical commits, or unsafe paths", async () => {
    const store = objects({ old: [], new: [] })
    expect(await readCommittedChanges(store, base, base)).toMatchObject({
      files: [],
      filesTruncated: false,
    })
    for (const path of ["../x", "/x", "a/../x", "x\0", "a//b"])
      expect(await readCommittedChangeFile(store, base, head, path)).toBeNull()
    expect(store.treeOf).not.toHaveBeenCalled()
    await expect(readCommittedChanges(store, "main", head)).rejects.toThrow(
      "full"
    )
  })
})

describe("committed patches", () => {
  it("leaves comparisons beyond the Worker's reads to Git", async () => {
    const huge = objects({
      old: [],
      new: Array.from({ length: 5001 }, (_, i) =>
        blob(`file-${i}`, `hash-${i}`)
      ),
    })
    expect(await readCommittedPatch(huge, base, head, 200_000)).toBeNull()
    expect(huge.blob).not.toHaveBeenCalled()
    const large = objects(
      { old: [], new: [blob("large.txt", "large")] },
      { large: "x\n".repeat(500_001) }
    )
    expect(await readCommittedPatch(large, base, head, 200_000)).toBeNull()
  })

  it("decides binary files as Git does, from a NUL within the first 8000 bytes", async () => {
    const late = new Uint8Array(9000).fill(0x61)
    late[8500] = 0
    const store = objects(
      { old: [], new: [blob("early.bin", "early"), blob("late.txt", "late")] },
      { early: new Uint8Array([0x89, 0x50, 0, 1]), late }
    )
    const patch = await readCommittedPatch(store, base, head, 200_000)
    expect(patch?.changedPaths).toEqual(["early.bin", "late.txt"])
    expect(patch?.diff).toContain(
      "Binary files /dev/null and b/early.bin differ\n"
    )
    expect(patch?.diff).not.toContain("b/late.txt differ")
    expect(patch?.diff).toContain("+++ b/late.txt\n@@ -0,0 +1 @@\n+aaa")
  })

  it("stops reading blobs once the patch exceeds its limit", async () => {
    const files = ["a", "b", "c", "d"]
    const store = objects(
      { old: [], new: files.map((name) => blob(name, name)) },
      Object.fromEntries(files.map((name) => [name, `${name}\n`.repeat(20)]))
    )
    const patch = await readCommittedPatch(store, base, head, 10)
    expect(patch!.diff.length).toBeGreaterThan(10)
    expect(store.blob).toHaveBeenCalledTimes(2)
  })
})
