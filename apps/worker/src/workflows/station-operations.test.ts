import { describe, expect, it, vi } from "vitest"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"

describe("Station workspace preparation", () => {
  it("forks a new Train's first Station from Terminus, and later Stations from the Train", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    const fork = vi.spyOn(ports.station.repositories, "fork")

    await drive(ports, train.id)

    const accepted = (await ports.store.train(train.id))!.value
    expect(accepted.carIds).toHaveLength(2)
    expect(fork.mock.calls.map(([input]) => input)).toEqual([
      {
        sourceRepoId: train.repoId,
        commit: train.headCommit,
        name: ports.runs[0]!.runId,
        preferredSourceRepoId: network.terminusRepoId,
      },
      {
        sourceRepoId: train.repoId,
        commit: expect.not.stringMatching(`^${train.headCommit}$`),
        name: ports.runs[1]!.runId,
      },
    ])
  })
})
