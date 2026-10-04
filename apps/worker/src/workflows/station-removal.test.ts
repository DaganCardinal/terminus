import { describe, expect, it, vi } from "vitest"
import { FakeConductor } from "@terminus/agent-runtime"
import { domainEventSchema } from "@terminus/protocol"
import { blockTrain } from "@terminus/domain"
import {
  drive,
  manifest,
  seedLine,
  seedNetwork,
  testPorts,
} from "../../test/fixtures"
import { removeStation } from "../agents/dispatcher"
import { advanceTrain } from "./train-operations"

describe("durable Station removal", () => {
  it("blocks legacy work before signaling, alerts Dispatch, then removes it and proceeds", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, line, stations } = await seedLine(ports, network.id, {
      name: "Legacy",
      stations: [
        {
          key: "verify",
          name: "Verify",
          manifest: manifest({ repositoryChange: undefined }),
        },
        { key: "change", name: "Change", manifest: manifest() },
      ],
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(0)
    expect(
      (await ports.store.station(stations[0]!.id))!.value.state.status
    ).toBe("waiting")
    const events = await ports.store.eventsAfter(network.id, 0)
    expect(events.some((e) => e.event.type === "station.signaled")).toBe(false)
    expect(domainEventSchema.parse(events.at(-1)!.event)).toMatchObject({
      type: "dispatcher.user_attention_requested",
      stationId: stations[0]!.id,
      issues: [{ kind: "station_change_required" }],
    })
    await removeStation(ports.dispatcher, network.id, stations[0]!.id, {
      reason: "Verification is already covered",
    })
    await removeStation(ports.dispatcher, network.id, stations[0]!.id, {
      reason: "Repeated request",
    })
    expect((await ports.store.train(train.id))!.value.state.status).toBe(
      "blocked"
    )
    expect(
      (await ports.store.station(stations[0]!.id))!.value.removalRequest
    ).toEqual({ reason: "Verification is already covered" })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    expect((await ports.store.line(line.id))!.stationIds).toEqual(
      line.stationIds
    )
    const removed = (await ports.store.station(stations[0]!.id))!.value
    expect(removed.state).toEqual({
      status: "cancelled",
      reason: "Verification is already covered",
    })
    expect(removed.removalRequest).toBeUndefined()
    expect(ports.runs.map((r) => r.stationId)).toEqual([stations[1]!.id])
    expect(
      (await ports.store.eventsAfter(network.id, 0)).filter(
        (e) => e.event.type === "station.removal_requested"
      )
    ).toHaveLength(1)
  })
  it("removes blocked review work while keeping prior Cars, evidence and commit identities", async () => {
    const base = new FakeConductor()
    const ports = testPorts({
      conductor: {
        model: "test",
        review: async (input) =>
          input.manifest.goal === "Final verification"
            ? {
                verdict: "escalate",
                summary: "No actual Git diff is available for review",
                findings: [],
              }
            : base.review(input),
      },
    })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id, {
      name: "Red",
      stations: [
        { key: "change", name: "Change", manifest: manifest() },
        {
          key: "final",
          name: "Final",
          manifest: manifest({ goal: "Final verification" }),
        },
      ],
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    const before = (await ports.store.train(train.id))!.value
    expect(before.carIds).toHaveLength(1)
    const review = (await ports.store.station(stations[1]!.id))!.value
      .lastReview
    expect(review?.feedback.summary).toContain("No actual Git diff")
    await removeStation(ports.dispatcher, network.id, stations[1]!.id, {
      reason: "Redundant",
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    const after = (await ports.store.train(train.id))!.value
    expect(after.headCommit).toBe(before.headCommit)
    expect(after.carIds).toEqual(before.carIds)
    expect(
      (await ports.store.station(stations[1]!.id))!.value.lastReview
    ).toEqual(review)
    expect(ports.runs).toHaveLength(2)
  })
  it("refuses dependent work across Lines and preserves unrelated Train blockers", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id, {
      name: "Source",
      stations: [{ key: "a", name: "A", manifest: manifest() }],
    })
    const other = await seedLine(ports, network.id, {
      name: "Other",
      stations: [
        {
          key: "b",
          name: "B",
          manifest: manifest({ dependencies: [stations[0]!.id] }),
        },
      ],
    })
    await expect(
      removeStation(ports.dispatcher, network.id, stations[0]!.id, {
        reason: "Remove",
      })
    ).rejects.toThrow("unfinished Stations")
    const loaded = (await ports.store.train(other.train.id))!
    const blocked = blockTrain(loaded.value, [
      { kind: "conflict", detail: "Unresolved" },
    ])
    if (!blocked.ok) throw new Error(blocked.error.message)
    await ports.store.commit(
      network.id,
      [{ kind: "train", train: blocked.value, version: loaded.version }],
      blocked.events
    )
    await removeStation(ports.dispatcher, network.id, other.stations[0]!.id, {
      reason: "Remove dependent first",
    })
    expect(await advanceTrain(ports.train, other.train.id)).toEqual({
      kind: "moved",
    })
    expect(
      (await ports.store.train(other.train.id))!.value.state
    ).toMatchObject({ status: "blocked", issues: [{ kind: "conflict" }] })
    await removeStation(ports.dispatcher, network.id, stations[0]!.id, {
      reason: "Now safe",
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
  })
  it("recovers a lost wakeup and rejects late requests for active work", async () => {
    const ports = testPorts()
    ports.dispatcher.notifyTrainCommand = vi.fn(async () => {
      throw new Error("Lost wake")
    })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id, {
      name: "Red",
      stations: [
        { key: "a", name: "A", manifest: manifest() },
        { key: "b", name: "B", manifest: manifest() },
      ],
    })
    await advanceTrain(ports.train, train.id)
    await expect(
      removeStation(ports.dispatcher, network.id, stations[0]!.id, {
        reason: "Too late",
      })
    ).rejects.toThrow("cannot be cancelled")
    await removeStation(ports.dispatcher, network.id, stations[1]!.id, {
      reason: "Unneeded future work",
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    expect(ports.runs).toHaveLength(1)
  })
  it("revalidates requests and atomically refuses cancellation if a dependent appears", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id, {
      name: "Red",
      stations: [
        { key: "a", name: "A", manifest: manifest() },
        { key: "b", name: "B", manifest: manifest() },
      ],
    })
    // Simulate a queued command prepared before the current dependency existed.
    const dependent = (await ports.store.station(stations[1]!.id))!
    await ports.store.commit(
      network.id,
      [
        {
          kind: "station",
          station: {
            ...dependent.value,
            manifest: {
              ...dependent.value.manifest,
              dependencies: [stations[0]!.id],
            },
          },
          version: dependent.version,
        },
      ],
      []
    )
    const target = (await ports.store.station(stations[0]!.id))!
    await ports.store.commit(
      network.id,
      [
        {
          kind: "station",
          station: {
            ...target.value,
            removalRequest: { reason: "Stale request" },
          },
          version: target.version,
        },
      ],
      [
        {
          type: "station.removal_requested",
          stationId: target.value.id,
          reason: "Stale request",
        },
      ]
    )
    await advanceTrain(ports.train, train.id)
    expect((await ports.store.station(target.value.id))!.value).toMatchObject({
      state: { status: "waiting" },
    })
    expect(
      (await ports.store.station(target.value.id))!.value.removalRequest
    ).toBeUndefined()
    expect(
      (await ports.store.eventsAfter(network.id, 0)).at(-1)!.event
    ).toMatchObject({ type: "station.removal_refused" })
    await expect(
      ports.store.commit(
        network.id,
        [
          {
            kind: "station",
            station: {
              ...target.value,
              state: { status: "cancelled", reason: "Raced command" },
            },
            version: target.version + 2,
          },
        ],
        [
          {
            type: "station.cancelled",
            stationId: target.value.id,
            reason: "Raced command",
          },
        ]
      )
    ).rejects.toThrow("reload and retry")
    expect(
      (await ports.store.eventsAfter(network.id, 0)).at(-1)!.event.type
    ).toBe("station.removal_refused")
  })
})
