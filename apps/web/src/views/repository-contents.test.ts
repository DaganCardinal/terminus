import { describe, expect, it } from "vitest"
import type { RepositoryOverview } from "@terminus/protocol"
import {
  buildTree,
  detectLicense,
  documentTitle,
  groupDocuments,
  languages,
  readmeSummary,
  resolveLink,
  slugify,
} from "./repository-contents"

const doc = (path: string, content = "") => ({
  path,
  content,
  truncated: false,
})

const overview: RepositoryOverview = {
  commit: "abc",
  filesTruncated: false,
  files: [
    { path: "README.md", size: 100 },
    { path: "LICENSE", size: 1000 },
    { path: "docs/architecture.md", size: 50 },
    { path: "src/App.tsx", size: 300 },
    { path: "src/readings/README.md", size: 20 },
    { path: "src/styles.css", size: 100 },
  ],
  documents: [
    doc(
      "README.md",
      "# Lantern\n\n[![build](x.svg)](ci)\n\nA small **dashboard** for [readings](docs/a.md).\n\n## More"
    ),
    doc(
      "LICENSE",
      "MIT License\n\nPermission is hereby granted, free of charge"
    ),
    doc("docs/architecture.md", "# How Lantern fits together\n\nText"),
    doc("src/readings/README.md", "# Readings"),
  ],
}

describe("documents", () => {
  it("keeps conventional names at the root and titles elsewhere", () => {
    expect(documentTitle(overview.documents[0]!)).toBe("README")
    expect(documentTitle(overview.documents[2]!)).toBe(
      "How Lantern fits together"
    )
    expect(documentTitle(doc("docs/getting_started.txt"))).toBe(
      "Getting started"
    )
  })

  it("groups project, guide and codebase documents", () => {
    expect(
      groupDocuments(overview.documents).map((group) => [
        group.label,
        group.documents.map((document) => document.path),
      ])
    ).toEqual([
      ["Project", ["README.md", "LICENSE"]],
      ["Guides", ["docs/architecture.md"]],
      ["Around the codebase", ["src/readings/README.md"]],
    ])
  })

  it("summarises a README by its first prose paragraph", () => {
    expect(readmeSummary(overview)).toBe("A small dashboard for readings.")
  })

  it("recognises the license", () => {
    expect(detectLicense(overview)).toEqual({
      name: "MIT License",
      path: "LICENSE",
    })
  })
})

describe("links", () => {
  it("resolves relative links against the current document", () => {
    expect(
      resolveLink(
        "../../docs/architecture.md#x",
        "src/readings/README.md",
        overview
      )
    ).toEqual({
      kind: "document",
      path: "docs/architecture.md",
      anchor: "x",
    })
    expect(resolveLink("./App.tsx", "src/README.md", overview)).toEqual({
      kind: "file",
      path: "src/App.tsx",
    })
  })

  it("opens a directory's README and flags what the commit lacks", () => {
    expect(resolveLink("src/readings/", "README.md", overview)).toMatchObject({
      kind: "document",
      path: "src/readings/README.md",
    })
    expect(resolveLink("nope.md", "README.md", overview)).toEqual({
      kind: "missing",
      path: "nope.md",
    })
  })

  it("leaves external links and anchors alone", () => {
    expect(resolveLink("https://example.com", "README.md", overview).kind).toBe(
      "external"
    )
    expect(resolveLink("mailto:a@b.c", "README.md", overview).kind).toBe(
      "external"
    )
    expect(resolveLink("#setup", "README.md", overview)).toEqual({
      kind: "anchor",
      id: "setup",
    })
  })

  it("slugs headings like GitHub", () => {
    expect(slugify("Getting started!")).toBe("getting-started")
    expect(slugify("API v2 — notes")).toBe("api-v2--notes")
  })
})

describe("files", () => {
  it("nests directories before files", () => {
    const tree = buildTree(overview.files)
    expect(tree.map((node) => node.name)).toEqual([
      "docs",
      "src",
      "LICENSE",
      "README.md",
    ])
    const src = tree[1]!
    expect(
      src.kind === "directory" && src.children.map((node) => node.name)
    ).toEqual(["readings", "App.tsx", "styles.css"])
  })

  it("measures languages by size", () => {
    expect(languages(overview.files)).toEqual([
      { name: "TypeScript", share: 300 / 570 },
      { name: "Markdown", share: 170 / 570 },
      { name: "CSS", share: 100 / 570 },
    ])
  })
})
