import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { RepositoryAccess } from "@terminus/artifacts"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import {
  prepareTrainPreview,
  previewBaseUrl,
  routeTrainPreview,
} from "./train-preview"

async function fixture() {
  const ports = testPorts()
  const network = await seedNetwork(ports)
  const { train } = await seedLine(ports, network.id)
  const accepted = { ...train, headCommit: "a".repeat(40) }
  const access: RepositoryAccess = {
    repoId: train.repoId,
    remote: "https://account.artifacts.cloudflare.net/git/default/train.git",
    branch: "main",
    token: "read-only-secret",
    tokenId: "read-token",
    scope: "read",
  }
  const repositories = {
    access: vi.fn(async () => access),
    revoke: vi.fn(async () => {}),
  }
  const sandbox = {
    prepareTrainPreview: vi.fn(async () => ({ token: "b".repeat(24) })),
  }
  const sandboxFor = vi.fn((name: string) => {
    expect(name).toMatch(/^preview-[a-f0-9]{24}$/)
    return sandbox
  })
  return { ports, accepted, access, repositories, sandbox, sandboxFor }
}

describe("Train preview", () => {
  it("uses the accepted snapshot with read-only access, revokes the token, and never changes the Train", async () => {
    const f = await fixture()
    const result = await prepareTrainPreview(
      f.accepted,
      new URL("http://localhost:8787"),
      f.repositories,
      f.sandboxFor
    )
    expect(f.repositories.access).toHaveBeenCalledWith(
      f.accepted.repoId,
      "read"
    )
    expect(f.sandbox.prepareTrainPreview).toHaveBeenCalledWith({
      remote: f.access.remote,
      token: f.access.token,
      commit: f.accepted.headCommit,
      hostname: "localhost",
    })
    expect(f.repositories.revoke).toHaveBeenCalledWith(f.access)
    expect(result).toMatchObject({
      trainId: f.accepted.id,
      commit: f.accepted.headCommit,
    })
    expect(result.url).toMatch(
      /^http:\/\/preview-[a-f0-9]{24}-b{24}\.localhost:8787\/$/
    )
    expect(JSON.stringify(result)).not.toContain(f.access.token)
    expect(
      (await f.ports.store.train(f.accepted.id))!.value.headCommit
    ).not.toBe(f.accepted.headCommit)
  })

  it("reuses a Sandbox identity for a snapshot and isolates later accepted commits", async () => {
    const f = await fixture()
    for (const train of [
      f.accepted,
      f.accepted,
      { ...f.accepted, headCommit: "c".repeat(40) },
    ])
      await prepareTrainPreview(
        train,
        new URL("https://previews.example.test"),
        f.repositories,
        f.sandboxFor
      )
    const names = f.sandboxFor.mock.calls.map(([name]) => name)
    expect(names[0]).toBe(names[1])
    expect(names[2]).not.toBe(names[0])
  })

  it("revokes access when startup or response validation fails", async () => {
    const f = await fixture()
    f.sandbox.prepareTrainPreview.mockRejectedValueOnce(
      new Error("build failed")
    )
    await expect(
      prepareTrainPreview(
        f.accepted,
        new URL("http://localhost:8787"),
        f.repositories,
        f.sandboxFor
      )
    ).rejects.toThrow("build failed")
    expect(f.repositories.revoke).toHaveBeenCalledWith(f.access)
  })

  it("routes all paths on a preview hostname to the preview, including API paths", async () => {
    const name = `preview-${"a".repeat(24)}`
    const token = "b".repeat(24)
    const request = new Request(
      `http://${name}-${token}.localhost:8787/api/trains/x/clear?x=1`
    )
    const sandbox = {
      fetchTrainPreview: vi.fn(async () => new Response("app response")),
    }
    const getByName = vi.fn(() => sandbox)
    const bindings = {
      ...env,
      PREVIEW_BASE_URL: "",
      SANDBOX: { getByName },
    } as unknown as Env
    const response = await routeTrainPreview(request, bindings)
    expect(await response!.text()).toBe("app response")
    expect(getByName).toHaveBeenCalledWith(name)
    expect(sandbox.fetchTrainPreview).toHaveBeenCalledWith(request, token)
    expect(
      await routeTrainPreview(
        new Request("http://localhost:8787/api/networks"),
        bindings
      )
    ).toBeNull()
    expect(
      (await routeTrainPreview(
        new Request("http://station-other.localhost:8787/api/networks"),
        bindings
      ))!.status
    ).toBe(404)
    expect(getByName).toHaveBeenCalledTimes(1)
  })

  it("handles Vite's local proxy and requires separate deployed preview routing", () => {
    expect(
      previewBaseUrl("http://localhost:5173/api/trains/a/preview").origin
    ).toBe("http://localhost:8787")
    expect(
      previewBaseUrl("http://localhost:8788/api/", "http://localhost:8788").port
    ).toBe("8788")
    const request = "https://terminus.example.test/api/"
    expect(() => previewBaseUrl(request)).toThrow("Configure PREVIEW_BASE_URL")
    for (const base of [
      "no-url",
      "http://previews.test",
      "https://terminus.example.test",
      "https://x.workers.dev",
      "https://preview.test/path",
      "https://user:password@preview.test",
    ])
      expect(() => previewBaseUrl(request, base)).toThrow()
    expect(
      previewBaseUrl(request, "https://previews.example.test").origin
    ).toBe("https://previews.example.test")
  })
})
