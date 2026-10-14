import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import type { Train } from "@terminus/domain"
import { StaleWriteError } from "./network-store"

describe("NetworkStore", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves role models from a network override, then General, then the default", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const other = await seedNetwork(ports)
    const at = "2026-10-05T12:00:00.000Z"

    expect(await ports.store.generalModelSettings()).toEqual({
      settings: { preset: "extra_light" },
      updatedAt: null,
    })
    expect((await ports.store.roleModels(network.id)).dispatcher).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )

    await ports.store.setGeneralModelSettings({ preset: "light" }, at)
    expect((await ports.store.roleModels(network.id)).dispatcher).toBe(
      "@cf/zai-org/glm-5.3"
    )

    const medium = await ports.store.setNetworkModelSettings(
      network.id,
      { preset: "medium" },
      at
    )
    expect(medium).toEqual({
      override: { preset: "medium" },
      general: { preset: "light" },
      updatedAt: at,
    })
    expect((await ports.store.roleModels(network.id)).stationAgent).toBe(
      "@cf/moonshotai/kimi-k2.7-code"
    )
    expect((await ports.store.roleModels(other.id)).stationAgent).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )

    expect(
      (await ports.store.setNetworkModelSettings(network.id, null, at)).override
    ).toBeNull()
    expect((await ports.store.roleModels(network.id)).stationAgent).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )
    await ports.store.setGeneralModelSettings({ preset: "extra_light" }, at)
  })

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

  it("refuses a commit to a deleting network and keeps the batch atomic", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    const before = await ports.store.lastSeq(network.id)
    await env.DB.prepare("UPDATE networks SET deleting = 1 WHERE id = ?")
      .bind(network.id)
      .run()

    await expect(
      ports.store.commit(
        network.id,
        [
          {
            kind: "train",
            train: { ...train, state: { status: "siding", reason: "" } },
            version: 0,
          },
        ],
        [{ type: "train.sided", trainId: train.id, reason: "" }]
      )
    ).rejects.toThrow("network_deleting")
    expect(await ports.store.lastSeq(network.id)).toBe(before)
    expect((await ports.store.train(train.id))?.version).toBe(0)
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

  it("records when each Train status began and the state it left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"))
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)
    const view = async () =>
      (await ports.store.snapshot(network.id))!.trains.find(
        (v) => v.train.id === train.id
      )!
    const write = async (state: Train["state"], version: number) => {
      vi.setSystemTime(Date.now() + 60_000)
      await ports.store.commit(
        network.id,
        [{ kind: "train", train: { ...train, state }, version }],
        []
      )
    }
    expect(await view()).toMatchObject({
      stateEnteredAt: "2026-10-04T10:00:00.000Z",
      previous: null,
    })

    const ready = { status: "ready" as const, at: { kind: "depot" as const } }
    const moving: Train["state"] = {
      status: "in_transit",
      from: { kind: "depot" },
      toward: stations[0]!.id,
    }
    await write(moving, 0)
    expect(await view()).toMatchObject({
      stateEnteredAt: "2026-10-04T10:01:00.000Z",
      previous: { state: ready, enteredAt: "2026-10-04T10:00:00.000Z" },
    })

    // Writes that keep the status keep its start time.
    await write(moving, 1)
    expect((await view()).stateEnteredAt).toBe("2026-10-04T10:01:00.000Z")

    await write(
      {
        status: "blocked",
        issues: [{ kind: "conflict", detail: "Conflict" }],
        resume: ready,
      },
      2
    )
    expect(await view()).toMatchObject({
      stateEnteredAt: "2026-10-04T10:03:00.000Z",
      previous: { state: moving, enteredAt: "2026-10-04T10:01:00.000Z" },
    })
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

it("normalizes legacy Line ordering on reads and snapshots", async () => {
  const ports = testPorts(),
    network = await seedNetwork(ports)
  const { line } = await seedLine(ports, network.id)
  await env.DB.prepare(
    "UPDATE lines SET record=json_remove(record,'$.stops') WHERE id=?"
  )
    .bind(line.id)
    .run()
  const expected = line.stationIds.map((stationId) => ({
    kind: "station",
    stationId,
  }))
  expect((await ports.store.line(line.id))!.stops).toEqual(expected)
  expect((await ports.store.snapshot(network.id))!.lines[0]!.stops).toEqual(
    expected
  )
})
it("keeps a pending siding command from racing departure", async () => {
  const ports = testPorts(),
    network = await seedNetwork(ports)
  const { train } = await seedLine(ports, network.id)
  expect(await ports.store.requestSiding(train.id, "Abandon")).toBe(true)
  await expect(
    ports.store.commit(
      network.id,
      [
        {
          kind: "train",
          version: 0,
          train: {
            ...train,
            state: {
              status: "in_transit",
              from: { kind: "depot" },
              toward: "station",
            },
          },
        },
      ],
      []
    )
  ).rejects.toBeInstanceOf(StaleWriteError)
  expect((await ports.store.train(train.id))!.value.state.status).toBe("ready")
})
