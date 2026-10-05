import { describe, expect, it } from "vitest"
import { documentRank, isDocumentPath, isSecretPath } from "./repository-browse"

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
