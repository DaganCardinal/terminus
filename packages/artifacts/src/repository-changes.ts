import { structuredPatch } from "diff"
import type {
  RepositoryChangeEntry,
  RepositoryChangeFile,
  RepositoryChanges,
} from "@terminus/protocol"
import { requireCommit } from "./git"
import {
  isSecretPath,
  type CommittedObjects,
  type CommittedTreeEntry,
} from "./repository-browse"
import { fileKind, secretFilePatch } from "./secret-diff"

const MAX_FILES = 5000
const MAX_TREES = 1000
const MAX_DEPTH = 64
const MAX_FILE_BYTES = 128_000
const MAX_LINES = 10_000

type Entry = CommittedTreeEntry | undefined

function same(before: Entry, after: Entry): boolean {
  return (
    before?.hash === after?.hash &&
    before?.mode === after?.mode &&
    before?.type === after?.type
  )
}

function change(
  path: string,
  before: Entry,
  after: Entry
): RepositoryChangeEntry {
  return {
    path,
    kind: !before ? "added" : !after ? "deleted" : "modified",
    beforeMode: before?.mode ?? null,
    afterMode: after?.mode ?? null,
  }
}

interface ChangedEntry {
  path: string
  before: Entry
  after: Entry
}

/**
 * Every changed non-tree entry between two commits, in path order. Only
 * differing subtrees are read, and `include` prunes a path and all below it.
 */
async function walkChanges(
  objects: CommittedObjects,
  base: string,
  head: string,
  include: (path: string) => boolean
): Promise<{ changes: ChangedEntry[]; truncated: boolean }> {
  const changes: ChangedEntry[] = []
  const result = { changes, truncated: false }
  if (base === head) return result
  const [before, after] = await Promise.all([
    objects.treeOf(base),
    objects.treeOf(head),
  ])
  let reads = 0
  const trees = new Map<string, Promise<CommittedTreeEntry[]>>()
  const tree = (hash: string) => {
    let pending = trees.get(hash)
    if (!pending) {
      if (++reads > MAX_TREES) {
        result.truncated = true
        return Promise.resolve([])
      }
      pending = objects.tree(hash)
      trees.set(hash, pending)
    }
    return pending
  }
  const add = (path: string, before: Entry, after: Entry) => {
    if (changes.length === MAX_FILES) result.truncated = true
    else changes.push({ path, before, after })
  }
  const visit = async (
    before: string | undefined,
    after: string | undefined,
    prefix: string,
    depth: number
  ): Promise<void> => {
    if (before === after || result.truncated) return
    if (depth > MAX_DEPTH) {
      result.truncated = true
      return
    }
    const [oldEntries, newEntries] = await Promise.all([
      before ? tree(before) : [],
      after ? tree(after) : [],
    ])
    if (result.truncated) return
    const oldMap = new Map(oldEntries.map((entry) => [entry.name, entry]))
    const newMap = new Map(newEntries.map((entry) => [entry.name, entry]))
    for (const name of [
      ...new Set([...oldMap.keys(), ...newMap.keys()]),
    ].sort()) {
      if (!validSegment(name))
        throw new Error("Artifacts returned an invalid tree path")
      const path = prefix + name
      if (!include(path)) continue
      const old = oldMap.get(name),
        next = newMap.get(name)
      if (same(old, next)) continue
      const oldTree = old?.type === "tree",
        nextTree = next?.type === "tree"
      if (oldTree || nextTree) {
        // A directory replaced by a file (or vice versa) includes both sides.
        if (old && !oldTree) add(path, old, undefined)
        if (next && !nextTree) add(path, undefined, next)
        await visit(
          oldTree ? old!.hash : undefined,
          nextTree ? next!.hash : undefined,
          `${path}/`,
          depth + 1
        )
      } else add(path, old, next)
      if (result.truncated) break
    }
  }
  await visit(before, after, "", 0)
  return result
}

/** Compare only differing subtrees; unchanged trees require no further reads. */
export async function readCommittedChanges(
  objects: CommittedObjects,
  base: string,
  head: string
): Promise<RepositoryChanges> {
  requireCommit(base)
  requireCommit(head)
  const { changes, truncated } = await walkChanges(
    objects,
    base,
    head,
    (path) => !isSecretPath(path)
  )
  return {
    base,
    head,
    files: changes.map(({ path, before, after }) =>
      change(path, before, after)
    ),
    filesTruncated: truncated,
  }
}

function validSegment(segment: string): boolean {
  return (
    !!segment &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\0")
  )
}

async function entryAt(
  objects: CommittedObjects,
  commit: string,
  path: string
): Promise<Entry> {
  const segments = path.split("/")
  let hash = await objects.treeOf(commit)
  for (const [index, segment] of segments.entries()) {
    const entry = (await objects.tree(hash)).find(
      (candidate) => candidate.name === segment
    )
    if (index === segments.length - 1)
      return entry?.type === "tree" ? undefined : entry
    if (entry?.type !== "tree") return undefined
    hash = entry.hash
  }
  return undefined
}

type Contents =
  | { status: "text"; content: string; size: number | null }
  | { status: "binary" | "too_large" | "unsupported"; size: number | null }

async function contents(
  objects: CommittedObjects,
  entry: Entry
): Promise<Contents> {
  if (!entry) return { status: "text", content: "", size: null }
  // Never follow symlinks or load submodule repositories.
  if (entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode))
    return { status: "unsupported", size: null }
  const size = await objects.blobSize(entry.hash)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("Invalid Artifacts blob size")
  if (size > MAX_FILE_BYTES) return { status: "too_large", size }
  const reader = (await objects.blob(entry.hash)).getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  let content = "",
    bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_FILE_BYTES) return { status: "too_large", size }
      if (value.includes(0)) return { status: "binary", size }
      try {
        content += decoder.decode(value, { stream: true })
      } catch {
        return { status: "binary", size }
      }
    }
    try {
      content += decoder.decode()
    } catch {
      return { status: "binary", size }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { status: "text", content, size }
}

/** Bounded text comparison; never show a partial patch as the complete change. */
export function compareFileText(
  base: string,
  head: string,
  file: RepositoryChangeEntry,
  before: string,
  after: string,
  beforeSize: number | null,
  afterSize: number | null
): RepositoryChangeFile {
  const result: RepositoryChangeFile = {
    base,
    head,
    file,
    beforeSize,
    afterSize,
    status: "too_large",
    hunks: [],
  }
  if (
    before.split("\n").length > MAX_LINES ||
    after.split("\n").length > MAX_LINES
  )
    return result
  const patch = structuredPatch(
    file.path,
    file.path,
    before,
    after,
    undefined,
    undefined,
    {
      context: 3,
      maxEditLength: 1000,
      timeout: 50,
    }
  )
  if (!patch) return result
  return { ...result, status: "text", hunks: patch.hunks }
}

/** Resolve just one requested changed file, without loading the rest of the diff. */
export async function readCommittedChangeFile(
  objects: CommittedObjects,
  base: string,
  head: string,
  path: string
): Promise<RepositoryChangeFile | null> {
  requireCommit(base)
  requireCommit(head)
  const segments = path.split("/")
  if (
    base === head ||
    isSecretPath(path) ||
    segments.length > MAX_DEPTH + 1 ||
    !segments.every(validSegment)
  )
    return null
  const [before, after] = await Promise.all([
    entryAt(objects, base, path),
    entryAt(objects, head, path),
  ])
  if (same(before, after)) return null
  const file = change(path, before, after)
  const [old, next] = await Promise.all([
    contents(objects, before),
    contents(objects, after),
  ])
  if (old.status !== "text" || next.status !== "text") {
    const status =
      old.status === "unsupported" || next.status === "unsupported"
        ? "unsupported"
        : old.status === "too_large" || next.status === "too_large"
          ? "too_large"
          : "binary"
    return {
      base,
      head,
      file,
      beforeSize: old.size,
      afterSize: next.size,
      status,
      hunks: [],
    }
  }
  return compareFileText(
    base,
    head,
    file,
    old.content,
    next.content,
    old.size,
    next.size
  )
}

/** Larger blobs fall back to Git rather than be compared in the Worker. */
const MAX_PATCH_FILE_BYTES = 1_000_000

/** Git decides a blob is binary from a NUL byte within its first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000

const NULL_OID = "0".repeat(40)

/**
 * The patch and changed paths `git diff --no-renames --full-index` reports
 * between two commits, read from committed objects. Binary files are
 * summarized as plain `git diff` does, never encoded, and secret files follow
 * the rest with their contents withheld. Null when the comparison exceeds what
 * the Worker reads, so the caller can use Git instead. Reading stops once the
 * patch is longer than `maxLength`, leaving it incomplete.
 */
export async function readCommittedPatch(
  objects: CommittedObjects,
  base: string,
  head: string,
  maxLength: number
): Promise<{ diff: string; changedPaths: string[] } | null> {
  requireCommit(base)
  requireCommit(head)
  const { changes, truncated } = await walkChanges(
    objects,
    base,
    head,
    () => true
  )
  if (truncated) return null
  // Like Git, a path that changed kind is a deletion followed by an addition.
  const files = changes
    .filter(({ path }) => !isSecretPath(path))
    .flatMap(({ path, before, after }) =>
      before && after && fileKind(before.mode) !== fileKind(after.mode)
        ? [
            { path, before, after: undefined },
            { path, before: undefined, after },
          ]
        : [{ path, before, after }]
    )
  let diff = ""
  // Two files at a time keeps blob reads within the Worker's connection cap.
  for (let at = 0; at < files.length && diff.length <= maxLength; at += 2) {
    for (const patch of await Promise.all(
      files.slice(at, at + 2).map((file) => filePatch(objects, file))
    )) {
      if (patch === null) return null
      diff += patch
    }
  }
  for (const { path, before, after } of changes)
    if (isSecretPath(path)) diff += secretFilePatch(path, before, after)
  return { diff, changedPaths: changes.map(({ path }) => path) }
}

async function filePatch(
  objects: CommittedObjects,
  { path, before, after }: ChangedEntry
): Promise<string | null> {
  const lines = [`diff --git a/${path} b/${path}`]
  if (!before) lines.push(`new file mode ${after!.mode}`)
  else if (!after) lines.push(`deleted file mode ${before.mode}`)
  else if (before.mode !== after.mode)
    lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`)
  if (before?.hash === after?.hash) return `${lines.join("\n")}\n`
  lines.push(
    `index ${before?.hash ?? NULL_OID}..${after?.hash ?? NULL_OID}${
      before?.mode === after?.mode ? ` ${after!.mode}` : ""
    }`
  )
  const [old, next] = await Promise.all([
    patchText(objects, before),
    patchText(objects, after),
  ])
  if (old === null || next === null) return null
  const oldName = before ? `a/${path}` : "/dev/null"
  const newName = after ? `b/${path}` : "/dev/null"
  if (old.binary || next.binary) {
    lines.push(`Binary files ${oldName} and ${newName} differ`)
    return `${lines.join("\n")}\n`
  }
  const patch = structuredPatch(
    oldName,
    newName,
    old.text,
    next.text,
    undefined,
    undefined,
    { context: 3, timeout: 1000 }
  )
  if (!patch) return null
  if (patch.hunks.length) lines.push(`--- ${oldName}`, `+++ ${newName}`)
  for (const hunk of patch.hunks)
    lines.push(
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(
        hunk.newStart,
        hunk.newLines
      )} @@`,
      ...hunk.lines
    )
  return `${lines.join("\n")}\n`
}

/** Git omits a count of one, and an empty range starts at the line before it. */
function hunkRange(start: number, count: number): string {
  if (count === 1) return `${start}`
  return `${count === 0 ? start - 1 : start},${count}`
}

/** One side of a file comparison as Git sees it; null when too large to read here. */
async function patchText(
  objects: CommittedObjects,
  entry: Entry
): Promise<{ binary: true } | { binary: false; text: string } | null> {
  if (!entry) return { binary: false, text: "" }
  if (entry.type === "commit")
    return { binary: false, text: `Subproject commit ${entry.hash}\n` }
  const reader = (await objects.blob(entry.hash)).getReader()
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
  let text = "",
    bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (
        bytes < BINARY_PROBE_BYTES &&
        value.subarray(0, BINARY_PROBE_BYTES - bytes).includes(0)
      )
        return { binary: true }
      bytes += value.byteLength
      if (bytes > MAX_PATCH_FILE_BYTES) return null
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { binary: false, text: text + decoder.decode() }
}
