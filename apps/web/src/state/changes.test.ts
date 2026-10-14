import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  RepositoryChangeFile,
  RepositoryChanges,
} from "@terminus/protocol"
import { api } from "./api"
import { loadChangeFile, loadChanges } from "./changes"

afterEach(() => vi.restoreAllMocks())

describe("session-only changes cache", () => {
  it("shares in-flight reads and reuses a comparison only for the same entity and commits", async () => {
    const target = { trainId: "cache-sharing", base: "base", head: "head" }
    const spy = vi.spyOn(api, "changes").mockResolvedValue({
      ...target,
      files: [],
      filesTruncated: false,
    } as RepositoryChanges)
    const [a, b] = await Promise.all([
      loadChanges(target),
      loadChanges({ ...target }),
    ])
    expect(a).toBe(b)
    await loadChanges(target)
    expect(spy).toHaveBeenCalledTimes(1)
    await loadChanges({ ...target, head: "next" })
    await loadChanges({ ...target, carId: "car" })
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it("loads only requested files, keys by path, and retries failures", async () => {
    const target = { trainId: "cache-file", base: "base", head: "head" }
    const file = {
      ...target,
      file: {
        path: "a.ts",
        kind: "added",
        beforeMode: null,
        afterMode: "100644",
      },
      status: "text",
      beforeSize: null,
      afterSize: 0,
      hunks: [],
    } as RepositoryChangeFile
    const spy = vi
      .spyOn(api, "changeFile")
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValue(file)
    await expect(loadChangeFile(target, "a.ts")).rejects.toThrow(
      "Temporary failure"
    )
    await loadChangeFile(target, "a.ts")
    await loadChangeFile(target, "a.ts")
    expect(spy).toHaveBeenCalledTimes(2)
    await loadChangeFile(target, "b.ts")
    expect(spy).toHaveBeenCalledTimes(3)
  })
})
