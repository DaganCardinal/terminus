import { describe, expect, it, vi } from "vitest"
import type { RepositoryAccess } from "@terminus/artifacts"
import type { SandboxPreviewRequest } from "@terminus/protocol"
import { seedNetwork, testPorts } from "../../test/fixtures"
import { prepareTerminusPreview } from "./terminus-preview"
import { prepareRepositoryPreview } from "./repository-preview"

async function fixture() {
  const ports = testPorts()
  vi.spyOn(ports.dispatcher.repositories, "createTerminus").mockResolvedValue({
    repoId: "canonical-repo",
    headCommit: "a".repeat(40),
  })
  const network = await seedNetwork(ports)
  const access: RepositoryAccess = {
    repoId: network.terminusRepoId,
    remote:
      "https://account.artifacts.cloudflare.net/git/default/canonical.git",
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
    prepareTrainPreview: vi.fn<
      (input: SandboxPreviewRequest) => Promise<{ token: string }>
    >(async () => ({
      token: "b".repeat(24),
    })),
  }
  const sandboxFor = vi.fn<(name: string) => typeof sandbox>(() => sandbox)
  const prepare = (commit = network.terminusCommit) =>
    prepareTerminusPreview(
      network,
      commit,
      new URL("http://localhost:8787"),
      repositories,
      sandboxFor
    )
  return { ports, network, access, repositories, sandbox, sandboxFor, prepare }
}

describe("Terminus preview", () => {
  it("builds the canonical repository commit with read-only access and leaves all network state and events intact", async () => {
    const f = await fixture()
    const before = await f.ports.store.snapshot(f.network.id)
    const preview = await f.prepare()
    expect(f.repositories.access).toHaveBeenCalledWith(
      f.network.terminusRepoId,
      "read"
    )
    expect(f.sandbox.prepareTrainPreview).toHaveBeenCalledWith({
      remote: f.access.remote,
      token: f.access.token,
      commit: f.network.terminusCommit,
      hostname: "localhost",
    })
    expect(preview).toMatchObject({
      networkId: f.network.id,
      commit: f.network.terminusCommit,
    })
    expect(preview.url).toMatch(
      /^http:\/\/preview-[a-f0-9]{24}-b{24}\.localhost:8787\/$/
    )
    expect(JSON.stringify(preview)).not.toContain(f.access.token)
    expect(f.repositories.revoke).toHaveBeenCalledWith(f.access)
    expect(await f.ports.store.snapshot(f.network.id)).toEqual(before)
    expect(f.ports.runs).toEqual([])
    expect(f.ports.wakes).toEqual([])
  })

  it("refuses a stale displayed commit before granting repository access or starting a Sandbox", async () => {
    const f = await fixture()
    await expect(f.prepare("c".repeat(40))).rejects.toMatchObject({
      status: 409,
    })
    expect(f.repositories.access).not.toHaveBeenCalled()
    expect(f.sandboxFor).not.toHaveBeenCalled()
  })

  it("keeps an in-flight preview pinned when canonical state advances during preparation", async () => {
    const f = await fixture()
    const original = f.network.terminusCommit
    f.repositories.access.mockImplementationOnce(async () => {
      f.network.terminusCommit = "c".repeat(40)
      return f.access
    })
    const preview = await f.prepare()
    expect(preview.commit).toBe(original)
    expect(f.sandbox.prepareTrainPreview.mock.calls[0]?.[0]).toMatchObject({
      commit: original,
    })
    await f.prepare()
    expect(f.sandboxFor.mock.calls[0]?.[0]).not.toBe(
      f.sandboxFor.mock.calls[1]?.[0]
    )
  })

  it("reuses the same canonical snapshot while isolating different networks and Train previews", async () => {
    const f = await fixture()
    await f.prepare()
    await f.prepare()
    await prepareTerminusPreview(
      { ...f.network, id: "another-network" },
      f.network.terminusCommit,
      new URL("http://localhost:8787"),
      f.repositories,
      f.sandboxFor
    )
    await prepareRepositoryPreview(
      {
        identity: f.network.id,
        repoId: f.network.terminusRepoId,
        commit: f.network.terminusCommit,
      },
      new URL("http://localhost:8787"),
      f.repositories,
      f.sandboxFor
    )
    const names = f.sandboxFor.mock.calls.map(([name]) => name)
    expect(names[0]).toBe(names[1])
    expect(new Set([names[0], names[2], names[3]]).size).toBe(3)
  })

  it("revokes access on build failures and invalid Sandbox responses", async () => {
    const f = await fixture()
    f.sandbox.prepareTrainPreview.mockRejectedValueOnce(
      new Error("build failed")
    )
    await expect(f.prepare()).rejects.toThrow("build failed")
    f.sandbox.prepareTrainPreview.mockResolvedValueOnce({ token: "invalid" })
    await expect(f.prepare()).rejects.toThrow()
    expect(f.repositories.revoke).toHaveBeenCalledTimes(2)
  })
})
