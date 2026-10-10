import { describe, expect, it, vi } from "vitest"
import type { TerminusPreview } from "@terminus/protocol"
import { api } from "./api"
import {
  getTerminusPreview,
  prepareTerminusPreview,
  stopTerminusPreview,
} from "./terminus-previews"

vi.mock("./api", () => ({
  api: { previewTerminus: vi.fn(), stopTerminusPreview: vi.fn() },
}))

describe("Terminus preview state", () => {
  it("deduplicates requests and keeps a late old preview separate from a newer canonical commit", async () => {
    let finish!: (preview: TerminusPreview) => void
    const networkId = "advancing-network"
    const old = "a".repeat(40)
    const current = "c".repeat(40)
    const request = vi.mocked(api.previewTerminus).mockImplementationOnce(
      async () =>
        new Promise<TerminusPreview>((resolve) => {
          finish = resolve
        })
    )
    const preparing = prepareTerminusPreview(networkId, old)
    await prepareTerminusPreview(networkId, old)
    expect(request).toHaveBeenCalledTimes(1)
    expect(getTerminusPreview(networkId, old).status).toBe("preparing")
    expect(getTerminusPreview(networkId, current).status).toBe("idle")
    finish({ networkId, commit: old, url: "https://old.preview.test" })
    await preparing
    expect(getTerminusPreview(networkId, old)).toEqual({
      status: "ready",
      url: "https://old.preview.test",
    })
    expect(getTerminusPreview(networkId, current).status).toBe("idle")
    expect(getTerminusPreview("another-network", old).status).toBe("idle")
  })

  it("rejects mismatched responses and permits retrying or refreshing expired previews", async () => {
    const networkId = "retry-network"
    const commit = "a".repeat(40)
    const preview = { networkId, commit, url: "https://current.preview.test" }
    vi.mocked(api.previewTerminus).mockResolvedValueOnce({
      ...preview,
      commit: "b".repeat(40),
    })
    await prepareTerminusPreview(networkId, commit)
    expect(getTerminusPreview(networkId, commit)).toMatchObject({
      status: "idle",
      error: expect.stringContaining("did not match"),
    })
    vi.mocked(api.previewTerminus).mockResolvedValueOnce(preview)
    await prepareTerminusPreview(networkId, commit)
    expect(getTerminusPreview(networkId, commit).status).toBe("ready")
    vi.mocked(api.previewTerminus).mockRejectedValueOnce(
      new Error("Terminus changed")
    )
    await prepareTerminusPreview(networkId, commit)
    expect(getTerminusPreview(networkId, commit)).toEqual({
      status: "idle",
      error: "Terminus changed",
    })
  })

  it("stops only ready previews and reports a failed stop", async () => {
    const networkId = "stop-network"
    const commit = "a".repeat(40)
    const stop = vi.mocked(api.stopTerminusPreview)
    await stopTerminusPreview(networkId, commit)
    expect(stop).not.toHaveBeenCalled()
    vi.mocked(api.previewTerminus).mockResolvedValue({
      networkId,
      commit,
      url: "https://stop.preview.test",
    })
    await prepareTerminusPreview(networkId, commit)
    stop.mockResolvedValueOnce(undefined)
    const stopping = stopTerminusPreview(networkId, commit)
    expect(getTerminusPreview(networkId, commit).status).toBe("stopping")
    await stopping
    expect(stop).toHaveBeenCalledWith(networkId, commit)
    expect(getTerminusPreview(networkId, commit)).toEqual({ status: "idle" })
    await prepareTerminusPreview(networkId, commit)
    stop.mockRejectedValueOnce(new Error("Sandbox unavailable"))
    await stopTerminusPreview(networkId, commit)
    expect(getTerminusPreview(networkId, commit)).toEqual({
      status: "idle",
      error: "Sandbox unavailable",
    })
  })
})
