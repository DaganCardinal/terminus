import type {
  RepositoryDocument,
  RepositoryEntry,
  RepositoryOverview,
} from "@terminus/protocol"

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const directoryOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""

export const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path)

/** The first `# Heading` of a Markdown document, if it has one. */
function firstHeading(content: string): string | null {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(content)
  return match ? match[1]!.replace(/[`*_]/g, "") : null
}

/**
 * How a document is named in the navigation. Root files keep their
 * conventional names (README, AGENTS, LICENSE); guides use their own title.
 */
export function documentTitle(document: RepositoryDocument): string {
  const name = baseName(document.path)
  const stem = name.replace(/\.[^.]+$/, "")
  if (!document.path.includes("/") || /^readme$/i.test(stem)) return stem
  const heading = isMarkdown(name) ? firstHeading(document.content) : null
  if (heading && heading.length <= 48) return heading
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

export interface DocumentGroup {
  label: string
  documents: RepositoryDocument[]
}

/** Groups documents the way the navigation shows them, keeping server order. */
export function groupDocuments(
  documents: RepositoryDocument[]
): DocumentGroup[] {
  const groups: DocumentGroup[] = [
    { label: "Project", documents: [] },
    { label: "Guides", documents: [] },
    { label: "Around the codebase", documents: [] },
  ]
  for (const document of documents) {
    const group = !document.path.includes("/")
      ? groups[0]!
      : /^(docs?|\.github)\//i.test(document.path)
        ? groups[1]!
        : groups[2]!
    group.documents.push(document)
  }
  return groups.filter((group) => group.documents.length > 0)
}

/** The opening paragraph of a README, for a one-line project description. */
export function readmeSummary(overview: RepositoryOverview): string | null {
  const readme = overview.documents.find(
    (document) => !document.path.includes("/") && /^readme/i.test(document.path)
  )
  if (!readme) return null
  const paragraph = readme.content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block &&
        !/^(#|!\[|\[!\[|<|```|\||[-*+] |\d+\. |>)/.test(block) &&
        /[a-z]/i.test(block)
    )
  if (!paragraph) return null
  const text = paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text
}

const licenses: [RegExp, string][] = [
  [/MIT License|Permission is hereby granted, free of charge/i, "MIT License"],
  [/Apache License,?\s+Version 2\.0/i, "Apache 2.0"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "LGPL"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
  [/Mozilla Public License,?\s+(v\. |Version )?2\.0/i, "MPL 2.0"],
  [/BSD 3-Clause|Redistribution and use in source and binary forms/i, "BSD"],
  [
    /This is free and unencumbered software released into the public domain/i,
    "Unlicense",
  ],
  [/ISC License/i, "ISC License"],
]

/** The license a project declares, recognised from its license file. */
export function detectLicense(
  overview: RepositoryOverview
): { name: string; path: string } | null {
  const file = overview.documents.find(
    (document) =>
      !document.path.includes("/") &&
      /^(license|licence|copying)(\.|$)/i.test(document.path)
  )
  if (!file) return null
  const known = licenses.find(([pattern]) => pattern.test(file.content))
  return { name: known?.[1] ?? "View license", path: file.path }
}

const languageByExtension: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  css: "CSS",
  scss: "CSS",
  html: "HTML",
  md: "Markdown",
  mdx: "Markdown",
  py: "Python",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  php: "PHP",
  sql: "SQL",
  sh: "Shell",
  vue: "Vue",
  svelte: "Svelte",
  c: "C",
  h: "C",
  cpp: "C++",
  cs: "C#",
}

/** Language share by bytes, largest first, with the long tail as "Other". */
export function languages(
  files: RepositoryEntry[],
  limit = 4
): { name: string; share: number }[] {
  const totals = new Map<string, number>()
  let total = 0
  for (const file of files) {
    if (/(^|\/)(package-lock\.json|.*\.lock)$/.test(file.path)) continue
    const extension = /\.([^./]+)$/.exec(file.path)?.[1]?.toLowerCase()
    const language = extension ? languageByExtension[extension] : undefined
    if (!language) continue
    totals.set(language, (totals.get(language) ?? 0) + file.size)
    total += file.size
  }
  if (total === 0) return []
  const ranked = [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([name, size]) => ({ name, share: size / total }))
  const top = ranked.slice(0, limit)
  const rest = ranked.slice(limit).reduce((sum, entry) => sum + entry.share, 0)
  return rest > 0 ? [...top, { name: "Other", share: rest }] : top
}

export interface TreeDirectory {
  kind: "directory"
  name: string
  path: string
  children: TreeNode[]
}
export interface TreeFile {
  kind: "file"
  name: string
  path: string
  size: number
}
export type TreeNode = TreeDirectory | TreeFile

/** Nests a flat file inventory into directories, directories first. */
export function buildTree(files: RepositoryEntry[]): TreeNode[] {
  const root: TreeDirectory = {
    kind: "directory",
    name: "",
    path: "",
    children: [],
  }
  for (const file of files) {
    const parts = file.path.split("/")
    let directory = root
    parts.slice(0, -1).forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/")
      let next = directory.children.find(
        (child): child is TreeDirectory =>
          child.kind === "directory" && child.name === part
      )
      if (!next) {
        next = { kind: "directory", name: part, path, children: [] }
        directory.children.push(next)
      }
      directory = next
    })
    directory.children.push({
      kind: "file",
      name: parts.at(-1)!,
      path: file.path,
      size: file.size,
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
          a.name.localeCompare(b.name)
      )
      .map((node) =>
        node.kind === "directory"
          ? { ...node, children: sort(node.children) }
          : node
      )
  return sort(root.children)
}

export type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "anchor"; id: string }
  | { kind: "document"; path: string; anchor?: string }
  | { kind: "file"; path: string }
  | { kind: "missing"; path: string }

/**
 * Where a link inside a document leads. Relative links are resolved against
 * the document's directory and kept inside the reader when the commit has
 * the target; a link to a directory opens that directory's README.
 */
export function resolveLink(
  href: string,
  from: string,
  overview: Pick<RepositoryOverview, "files" | "documents">
): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return { kind: "external", href }
  if (href.startsWith("#")) return { kind: "anchor", id: href.slice(1) }
  const [rawPath = "", anchor] = href.split("#")
  const start = rawPath.startsWith("/") ? [] : directoryOf(from).split("/")
  const parts = start.filter(Boolean)
  for (const part of decodeURI(rawPath.split("?")[0]!).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  const path = parts.join("/")
  if (overview.documents.some((document) => document.path === path))
    return { kind: "document", path, anchor }
  if (overview.files.some((file) => file.path === path))
    return { kind: "file", path }
  const readme = overview.documents.find(
    (document) =>
      directoryOf(document.path) === path &&
      /^readme(\.|$)/i.test(baseName(document.path))
  )
  if (readme) return { kind: "document", path: readme.path, anchor }
  return { kind: "missing", path }
}

/** GitHub-style heading anchors: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-")
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
