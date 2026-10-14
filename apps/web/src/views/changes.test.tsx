import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Changes, FilePatch } from "./changes"
import { api } from "@/state/api"
import type { RepositoryChangeFile } from "@terminus/protocol"

const file: RepositoryChangeFile = {
  base: "base",
  head: "head",
  file: {
    path: "app.ts",
    kind: "modified",
    beforeMode: "100644",
    afterMode: "100644",
  },
  beforeSize: 1,
  afterSize: 1,
  status: "text",
  hunks: [],
}

describe("Changes sections", () => {
  it("starts closed without requesting any diffs", () => {
    const list = vi.spyOn(api, "changes"),
      files = vi.spyOn(api, "changeFile")
    const html = renderToStaticMarkup(
      <Changes
        target={{ trainId: "train", base: "base", head: "head" }}
        description="Accepted work."
      />
    )
    expect(html).toContain("<summary>Changes</summary>")
    expect(html).not.toContain(" open=")
    expect(list).not.toHaveBeenCalled()
    expect(files).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
  it("renders escaped text changes with addition and removal markers", () => {
    const html = renderToStaticMarkup(
      <FilePatch
        value={{
          ...file,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+<script>new</script>"],
            },
          ],
        }}
      />
    )
    expect(html).toContain('class="diff-remove"')
    expect(html).toContain('class="diff-add"')
    expect(html).toContain("+&lt;script&gt;new&lt;/script&gt;")
  })
  it("explains binary, oversized, unsupported and metadata-only changes", () => {
    for (const [status, text] of [
      ["binary", "Binary file changed"],
      ["too_large", "size or complexity limit"],
      ["unsupported", "Symlink or submodule changed"],
    ] as const) {
      expect(
        renderToStaticMarkup(<FilePatch value={{ ...file, status }} />)
      ).toContain(text)
    }
    expect(
      renderToStaticMarkup(
        <FilePatch
          value={{ ...file, file: { ...file.file, afterMode: "100755" } }}
        />
      )
    ).toContain("only metadata changed")
  })
})
