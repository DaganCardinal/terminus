import { describe, expect, it } from "vitest"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { StaleWriteError } from "./network-store"

describe("NetworkStore", () => {
  it("round-trips entities and appends events in order", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { line, stations, train } = await seedLine(ports, network.id)

    expect((await ports.store.network(network.id))?.validation).toEqual(
      network.validation
    )

    expect(await ports.store.line(line.id)).toEqual(line)
    expect((await ports.store.station(stations[0]!.id))?.value).toEqual(
      stations[0]
    )
    expect(await ports.store.train(train.id)).toEqual({
      value: train,
      version: 0,
      networkId: network.id,
    })

    const events = await ports.store.eventsAfter(network.id, 0)
    expect(events.map((envelope) => envelope.event.type)).toEqual([
      "line.created",
      "train.created",
    ])
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq)
    expect(await ports.store.eventsAfter(network.id, events[1]!.seq)).toEqual(
      []
    )
  })

  it("rejects a stale write and keeps the batch atomic", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    const sided = { ...train, state: { status: "siding" as const, reason: "" } }
    const event = {
      type: "train.sided" as const,
      trainId: train.id,
      reason: "",
    }

    await ports.store.commit(
      network.id,
      [{ kind: "train", train: sided, version: 0 }],
      [event]
    )
    const before = await ports.store.lastSeq(network.id)

    await expect(
      ports.store.commit(
        network.id,
        [{ kind: "train", train: sided, version: 0 }],
        [event]
      )
    ).rejects.toBeInstanceOf(StaleWriteError)
    expect(await ports.store.lastSeq(network.id)).toBe(before)
    expect((await ports.store.train(train.id))?.version).toBe(1)
  })

  it("snapshots the network with signals and the latest event", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)

    const snapshot = await ports.store.snapshot(network.id)
    expect(snapshot).toMatchObject({
      network: { id: network.id },
      trains: [{ train: { id: train.id }, signal: "green" }],
      lastSeq: await ports.store.lastSeq(network.id),
    })
    expect(snapshot?.stations).toHaveLength(2)
    expect(await ports.store.snapshot("missing")).toBeNull()
  })

  it("reports Station statuses and signal counts", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { stations } = await seedLine(ports, network.id)
    const [a] = stations

    expect(await ports.store.stationStatuses([a!.id, "missing"])).toEqual({
      [a!.id]: "waiting",
    })
    expect(await ports.store.signalCount(a!.id)).toBe(0)
  })
})
