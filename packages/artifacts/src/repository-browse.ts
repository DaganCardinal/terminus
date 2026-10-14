import type {
  RepositoryDocument,
  RepositoryEntry,
  RepositoryFile,
  RepositoryOverview,
} from "@terminus/protocol"
import {
  git,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"

const DIRECTORY = "/workspace/browse"
const MAX_FILES = 5000
const MAX_DOCUMENTS = 40
const MAX_DOCUMENT_CHARS = 200_000
const MAX_FILE_CHARS = 400_000
const MAX_TREES = 1000
const MAX_DEPTH = 64

/** Paths that may hold credentials are never listed or read. */
export function isSecretPath(path: string): boolean {
  return /(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|credentials[^/]*|[^/]*\.(pem|key))$/i.test(
    path
  )
}

const ignoredDirectory = /(^|\/)(node_modules|vendor|dist|build)\//

/** Prose a person reads to understand a project, as opposed to its source. */
export function isDocumentPath(path: string): boolean {
  if (ignoredDirectory.test(path)) return false
  const name = path.slice(path.lastIndexOf("/") + 1)
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/i.test(name)) return true
  return /^(license|licence|copying|notice|authors|readme)$/i.test(name)
}

/**
 * Ranks documents the way a newcomer would read them: the root README, agent
 * guidance, license and contribution notes, then `docs/`, then the rest by
 * depth. Lower sorts first.
 */
export function documentRank(path: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const root = !path.includes("/")
  const stem = name.replace(/\.[^.]+$/, "")
  if (root) {
    const order = [
      "readme",
      "agents",
      "claude",
      "license",
      "licence",
      "copying",
      "contributing",
      "code_of_conduct",
      "security",
      "changelog",
    ]
    const index = order.indexOf(stem)
    return index === -1 ? 20 : index
  }
  if (/^\.?github\//i.test(path)) return 30
  if (/^docs?\//i.test(path)) return 40 + path.split("/").length
  return 60 + path.split("/").length
}

async function clone(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string
): Promise<void> {
  requireCommit(commit)
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    access.remote,
    DIRECTORY,
  ])
  await git(workspace, ["cat-file", "-e", `${commit}^{commit}`], DIRECTORY)
}

async function inventory(
  workspace: GitWorkspace,
  commit: string,
  path?: string
): Promise<RepositoryEntry[]> {
  const output = await git(
    workspace,
    [
      "ls-tree",
      "-r",
      "--format=%(objectmode) %(objectsize) %(path)",
      "-z",
      commit,
      ...(path ? ["--", path] : []),
    ],
    DIRECTORY
  )
  return output
    .split("\0")
    .map((entry) => /^100(?:644|755) (\d+) (.+)$/s.exec(entry))
    .filter((match) => match !== null)
    .map((match) => ({ path: match[2]!, size: Number(match[1]) }))
    .filter((entry) => !isSecretPath(entry.path))
}

async function show(
  workspace: GitWorkspace,
  commit: string,
  path: string,
  limit: number
): Promise<{ content: string | null; truncated: boolean }> {
  const output = await workspace.run(
    ["git", "show", `${commit}:${path}`],
    DIRECTORY
  )
  if (output.exitCode !== 0) throw new Error(`Could not read ${path}`)
  if (output.stdout.includes("\0")) return { content: null, truncated: false }
  return {
    content: output.stdout.slice(0, limit),
    truncated: output.stdout.length > limit || output.outputTruncated === true,
  }
}

/** Inspect committed blobs with read-only Git access; never execute project code. */
export async function readRepositoryOverview(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string
): Promise<RepositoryOverview> {
  await clone(workspace, access, commit)
  const files = (await inventory(workspace, commit)).sort((a, b) =>
    a.path.localeCompare(b.path)
  )
  const candidates = files
    .filter((file) => isDocumentPath(file.path))
    .sort(
      (a, b) =>
        documentRank(a.path) - documentRank(b.path) ||
        a.path.localeCompare(b.path)
    )
    .slice(0, MAX_DOCUMENTS)
  const documents: RepositoryDocument[] = []
  for (const file of candidates) {
    const { content, truncated } = await show(
      workspace,
      commit,
      file.path,
      MAX_DOCUMENT_CHARS
    )
    if (content !== null)
      documents.push({ path: file.path, content, truncated })
  }
  return {
    commit,
    files: files.slice(0, MAX_FILES),
    filesTruncated: files.length > MAX_FILES,
    documents,
  }
}

/** One committed file, or null when the commit has no readable file there. */
export async function readRepositoryFile(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string,
  path: string
): Promise<RepositoryFile | null> {
  if (isSecretPath(path)) return null
  await clone(workspace, access, commit)
  const entry = (await inventory(workspace, commit, path)).find(
    (candidate) => candidate.path === path
  )
  if (!entry) return null
  const { content, truncated } = await show(
    workspace,
    commit,
    path,
    MAX_FILE_CHARS
  )
  return { commit, path, size: entry.size, content, truncated }
}

/** A Git tree entry, one level deep, as an object store reports it. */
export interface CommittedTreeEntry {
  name: string
  mode: string
  hash: string
  type: "blob" | "tree" | "commit"
}

/** Committed Git objects read by hash, without a workspace or repo token. */
export interface CommittedObjects {
  /** The commit's root tree; throws when the repository has no such commit. */
  treeOf(commit: string): Promise<string>
  tree(hash: string): Promise<CommittedTreeEntry[]>
  blobSize(hash: string): Promise<number>
  blob(hash: string): Promise<ReadableStream<Uint8Array>>
}

/** An overview from immutable Artifacts objects, without a clone or repo token. */
export async function readCommittedOverview(
  objects: CommittedObjects,
  commit: string
): Promise<RepositoryOverview> {
  requireCommit(commit)
  type File = { path: string; hash: string }
  const files: File[] = []
  const candidates: File[] = []
  let filesTruncated = false
  let trees = 0
  // Keep only the visible inventory and the highest-ranked documents, even for
  // repositories larger than the overview. Blob sizes are read only for these.
  const retain = (
    list: File[],
    file: File,
    limit: number,
    compare: (a: File, b: File) => number
  ) => {
    let low = 0,
      high = list.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compare(list[middle]!, file) < 0) low = middle + 1
      else high = middle
    }
    if (low < limit) list.splice(low, 0, file)
    if (list.length > limit) list.pop()
  }
  const visit = async (hash: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH || ++trees > MAX_TREES) {
      filesTruncated = true
      return
    }
    for (const entry of await objects.tree(hash)) {
      if (
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        /[/\0]/.test(entry.name)
      )
        throw new Error("Artifacts returned an invalid tree path")
      const path = prefix + entry.name
      if (isSecretPath(path)) continue
      if (entry.type === "tree") {
        await visit(entry.hash, `${path}/`, depth + 1)
      } else if (entry.type === "blob" && /^100(?:644|755)$/.test(entry.mode)) {
        const file = { path, hash: entry.hash }
        if (files.length === MAX_FILES) filesTruncated = true
        retain(files, file, MAX_FILES, (a, b) => a.path.localeCompare(b.path))
        if (isDocumentPath(path))
          retain(
            candidates,
            file,
            MAX_DOCUMENTS,
            (a, b) =>
              documentRank(a.path) - documentRank(b.path) ||
              a.path.localeCompare(b.path)
          )
      }
    }
  }
  await visit(await objects.treeOf(commit), "", 0)
  const inventory: RepositoryEntry[] = []
  const sizes = new Map<string, Promise<number>>()
  // Limit concurrent REST requests to stay within the Worker's connection cap.
  for (let at = 0; at < files.length; at += 4) {
    inventory.push(
      ...(await Promise.all(
        files.slice(at, at + 4).map(async ({ path, hash }) => {
          let size = sizes.get(hash)
          if (!size) {
            size = objects.blobSize(hash)
            sizes.set(hash, size)
          }
          return { path, size: await size }
        })
      ))
    )
  }
  const documents: RepositoryDocument[] = []
  for (const file of candidates) {
    const { content, truncated } = await readText(
      await objects.blob(file.hash),
      MAX_DOCUMENT_CHARS
    )
    if (content !== null)
      documents.push({ path: file.path, content, truncated })
  }
  return { commit, files: inventory, filesTruncated, documents }
}

/**
 * The same file `readRepositoryFile` returns, resolved one tree level at a
 * time: only regular files, never symlinks or submodules, and never secrets.
 */
export async function readCommittedFile(
  objects: CommittedObjects,
  commit: string,
  path: string
): Promise<RepositoryFile | null> {
  requireCommit(commit)
  if (isSecretPath(path)) return null
  const segments = path.split("/")
  if (segments.some((segment) => !segment)) return null
  let tree = await objects.treeOf(commit)
  for (const [index, segment] of segments.entries()) {
    const entry = (await objects.tree(tree)).find((e) => e.name === segment)
    if (index < segments.length - 1) {
      if (entry?.type !== "tree") return null
      tree = entry.hash
      continue
    }
    if (entry?.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode))
      return null
    const [size, body] = await Promise.all([
      objects.blobSize(entry.hash),
      objects.blob(entry.hash),
    ])
    const { content, truncated } = await readText(body, MAX_FILE_CHARS)
    return { commit, path, size, content, truncated }
  }
  return null
}

/** Reads at most `limit` characters, stopping early at the first NUL byte, which marks a binary file. */
async function readText(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<{ content: string | null; truncated: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.includes(0)) return { content: null, truncated: false }
      text += decoder.decode(value, { stream: true })
      if (text.length > limit)
        return { content: text.slice(0, limit), truncated: true }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  text += decoder.decode()
  return { content: text.slice(0, limit), truncated: text.length > limit }
}
