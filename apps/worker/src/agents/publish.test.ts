import {
  FakeRepositoryHost,
  RepositoryMovedError,
  type RepositoryHost,
} from "@terminus/artifacts"
import type { NetworkSummary, TerminusPublication } from "@terminus/protocol"
import { describe, expect, it, vi } from "vitest"
import type { NetworkStore } from "../integrations/network-store"
import { DispatchError } from "./dispatcher"
import { publishTerminus, type PublishPorts } from "./publish"

const old = "a".repeat(40)
const head = "b".repeat(40)

function setup(
  publication?: TerminusPublication,
  repositories: Partial<RepositoryHost> = {}
) {
  const network: NetworkSummary = {
    id: "network-1",
    name: "Demo",
    terminusRepoId: "terminus-network-1/terminus",
    terminusCommit: head,
    createdAt: "2026-10-13T00:00:00.000Z",
    ...(publication ? { publication } : {}),
  }
  const host = Object.assign(new FakeRepositoryHost(), {
    fork: vi.fn(async () => ({ repoId: "", headCommit: head })),
    fastForward: vi.fn(async () => {}),
    head: vi.fn(async () => old),
    ...repositories,
  })
  const commit = vi.fn(async () => {})
  const ports: PublishPorts = {
    store: { network: async () => network, commit } as unknown as NetworkStore,
    repositories: host,
    now: () => "2026-10-13T12:00:00.000Z",
  }
  return { ports, host, commit }
}

const published: TerminusPublication = {
  repoId: "terminus-network-1/publish",
  commit: old,
  publishedAt: "2026-10-13T10:00:00.000Z",
  siteUrl: "https://demo.example.workers.dev",
}

describe("publishTerminus", () => {
  it("forks the publish repository on the first publish", async () => {
    const { ports, host, commit } = setup()
    expect(await publishTerminus(ports, "network-1", head)).toEqual({
      repoId: "terminus-network-1/publish",
      commit: head,
      publishedAt: "2026-10-13T12:00:00.000Z",
    })
    expect(host.fork).toHaveBeenCalledWith({
      sourceRepoId: "terminus-network-1/terminus",
      commit: head,
      name: "publish",
    })
    expect(host.fastForward).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(
      "network-1",
      [
        {
          kind: "publication",
          publication: {
            repoId: "terminus-network-1/publish",
            commit: head,
            publishedAt: "2026-10-13T12:00:00.000Z",
          },
        },
      ],
      [{ type: "terminus.published", commit: head }]
    )
  })

  it("fast-forwards from the publish repository's current head and keeps the site URL", async () => {
    const { ports, host } = setup(published)
    expect(await publishTerminus(ports, "network-1", head)).toMatchObject({
      commit: head,
      siteUrl: published.siteUrl,
    })
    expect(host.fork).not.toHaveBeenCalled()
    expect(host.fastForward).toHaveBeenCalledWith({
      targetRepoId: "terminus-network-1/publish",
      sourceRepoId: "terminus-network-1/terminus",
      fromCommit: old,
      toCommit: head,
    })
  })

  it("recovers a publish repository whose record was lost", async () => {
    const { ports, host } = setup(undefined, {
      fork: vi.fn(async () => {
        throw new RepositoryMovedError("Fork did not preserve the commit")
      }),
    })
    await publishTerminus(ports, "network-1", head)
    expect(host.fastForward).toHaveBeenCalledWith(
      expect.objectContaining({ fromCommit: old, toCommit: head })
    )
  })

  it("refuses stale commits and repositories that moved", async () => {
    const stale = setup(published)
    await expect(
      publishTerminus(stale.ports, "network-1", old)
    ).rejects.toThrow(DispatchError)
    const moved = setup(published, {
      fastForward: vi.fn(async () => {
        throw new RepositoryMovedError("Target moved")
      }),
    })
    await expect(
      publishTerminus(moved.ports, "network-1", head)
    ).rejects.toMatchObject({ status: 409 })
    expect(moved.ports.store.commit).not.toHaveBeenCalled()
  })
})
