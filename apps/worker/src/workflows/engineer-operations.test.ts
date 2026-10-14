import { NetworkDeletionStore } from "../integrations/network-deletion-store"
import { env, SELF } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeEngineer, type EngineerAdvisor } from "@terminus/agent-runtime"
import { blockStation, blockTrain, sendToSiding } from "@terminus/domain"
import {
  manifest,
  seedLine,
  seedNetwork,
  testPorts,
  runStation,
} from "../../test/fixtures"
import { placeHold, releaseHold } from "../agents/dispatcher"
import {
  advanceTrain,
  recordStationOutcome,
  clearTrain,
  stationRunId,
} from "./train-operations"
import { assessEngineer, observeEngineer } from "./engineer-operations"

async function setup(crossing = false) {
  const engineer = new FakeEngineer({
    notifyDispatcher: true,
    stationFailure: "retry",
  })
  const notify = vi.spyOn(engineer as EngineerAdvisor, "notifyDispatcher")
  const ports = testPorts({ engineer })
  const network = await seedNetwork(ports)
  const source = await seedLine(ports, network.id, {
    name: "Source",
    stations: [{ key: "a", name: "Source Station", manifest: manifest() }],
  })
  const receiver = await seedLine(ports, network.id, {
    name: "Receiver",
    stations: [
      {
        key: "b",
        name: "Receiver Station",
        manifest: manifest({
          dependencies: crossing ? [] : [source.stations[0]!.id],
        }),
      },
    ],
    ...(crossing
      ? {
          route: [
            {
              kind: "crossing" as const,
              source: {
                kind: "existing" as const,
                stationId: source.stations[0]!.id,
              },
            },
            { kind: "station" as const, key: "b" },
          ],
        }
      : {}),
  })
  await advanceTrain(ports.train, receiver.train.id)
  const base = Date.now()
  const time = (minutes: number) => {
    ports.train.now = () => new Date(base + minutes * 60_000).toISOString()
  }
  return { ports, network, source, receiver, notify, time }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("Engineer observations", () => {
  it.each([false, true])(
    "assesses %s Crossing waits once per milestone and persists acknowledgment",
    async (crossing) => {
      const w = await setup(crossing)
      w.time(29)
      await observeEngineer(w.ports.train, w.receiver.train.id)
      expect(w.notify).not.toHaveBeenCalled()
      w.time(30)
      await observeEngineer(w.ports.train, w.receiver.train.id)
      await observeEngineer(w.ports.train, w.receiver.train.id)
      expect(w.notify).toHaveBeenCalledTimes(1)
      let snapshot = (await w.ports.store.snapshot(w.network.id))!
      expect(snapshot.engineerNotices).toHaveLength(1)
      const notice = snapshot.engineerNotices![0]!
      expect(
        snapshot.trains.find((view) => view.train.id === w.receiver.train.id)
          ?.train.state.status
      ).toBe("held")
      w.time(60)
      await observeEngineer(w.ports.train, w.receiver.train.id)
      expect(w.notify).toHaveBeenCalledTimes(2)
      expect(
        (await w.ports.store.snapshot(w.network.id))!.engineerNotices
      ).toHaveLength(1)
      const response = await SELF.fetch(
        `https://terminus.test/api/networks/${w.network.id}/engineer-notices/${notice.id}/acknowledge`,
        { method: "POST" }
      )
      expect(response.status).toBe(200)
      const duplicate = await SELF.fetch(
        `https://terminus.test/api/networks/${w.network.id}/engineer-notices/${notice.id}/acknowledge`,
        { method: "POST" }
      )
      expect(duplicate.status).toBe(200)
      w.time(240)
      await observeEngineer(w.ports.train, w.receiver.train.id)
      snapshot = (await w.ports.store.snapshot(w.network.id))!
      expect(snapshot.engineerNotices).toEqual([])
      expect(w.notify).toHaveBeenCalledTimes(2)
      const events = await w.ports.store.eventsAfter(w.network.id, 0)
      expect(
        events.filter(
          (row) => row.event.type === "dispatcher.engineer_notice_raised"
        )
      ).toHaveLength(1)
      expect(
        events.filter(
          (row) => row.event.type === "dispatcher.engineer_notice_acknowledged"
        )
      ).toHaveLength(1)
      expect(
        (
          await SELF.fetch(
            `https://terminus.test/api/networks/wrong/engineer-notices/${notice.id}/acknowledge`,
            { method: "POST" }
          )
        ).status
      ).toBe(404)
    }
  )
  it("notifies immediately for upstream blockage even when Clef would stay quiet", async () => {
    const w = await setup()
    w.notify.mockResolvedValue({ value: false, confidence: 1 })
    await advanceTrain(w.ports.train, w.source.train.id)
    const source = await w.ports.store.station(w.source.stations[0]!.id)
    const stopped = blockStation(source!.value, [
      { kind: "station_failed", detail: "Broken setup" },
    ])
    if (!stopped.ok) throw new Error("Cannot block")
    await w.ports.store.commit(
      w.network.id,
      [{ kind: "station", station: stopped.value, version: source!.version }],
      stopped.events
    )
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).not.toHaveBeenCalled()
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices?.[0]
        ?.summary
    ).toContain("blocked")
  })
  it("suppresses deliberate pauses, retains blockers, and resets after pause release", async () => {
    const w = await setup()
    const hold = await placeHold(w.ports.dispatcher, w.network.id, {
      kind: "user",
      scope: { kind: "train", trainId: w.source.train.id },
      note: "Pause",
    })
    w.time(120)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).not.toHaveBeenCalled()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(w.ports.train.now()))
    await releaseHold(w.ports.dispatcher, w.network.id, hold.id)
    // A fresh clock starts at release, rather than the original dependency wait.
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).not.toHaveBeenCalled()
    // This case also exercises source work that was paused before its first departure.
    expect(
      (await w.ports.store.snapshot(w.network.id))!.trains.find(
        (view) => view.train.id === w.receiver.train.id
      )?.train.state.status
    ).toBe("held")
  })
  it("resolves on upstream progress and ignores unrelated network events", async () => {
    const w = await setup()
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    await w.ports.store.commit(
      w.network.id,
      [],
      [{ type: "terminus.published", commit: "unrelated" }]
    )
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).toHaveBeenCalledTimes(1)
    await advanceTrain(w.ports.train, w.source.train.id)
    // Reset to the time of the freshly recorded progress.
    w.ports.train.now = () => new Date().toISOString()
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices
    ).toEqual([])
    const events = await w.ports.store.eventsAfter(w.network.id, 0)
    expect(
      events.some(
        (row) => row.event.type === "dispatcher.engineer_notice_resolved"
      )
    ).toBe(true)
  })
  it("discards a notice when upstream progress happens during the model call", async () => {
    const w = await setup()
    w.time(30)
    w.notify.mockImplementation(async () => {
      await advanceTrain(w.ports.train, w.source.train.id)
      return { value: true, confidence: 1 }
    })
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices
    ).toEqual([])
  })
  it("counts multiple waiting Trains in the compact decision context", async () => {
    const w = await setup()
    const other = await seedLine(w.ports, w.network.id, {
      name: "Other receiver",
      stations: [
        {
          key: "c",
          name: "C",
          manifest: manifest({ dependencies: [w.source.stations[0]!.id] }),
        },
      ],
    })
    await advanceTrain(w.ports.train, other.train.id)
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify.mock.calls[0]?.[0].dependencies?.[0]?.waitingTrains).toBe(2)
  })
  it("checkpoints assessments and their events without rerunning the model", async () => {
    const w = await setup()
    const ask = vi.fn(async () => ({
      value: "retry" as const,
      confidence: 0.8,
    }))
    await assessEngineer(
      w.ports.train,
      w.network.id,
      w.source.train.id,
      "station_failure",
      "run",
      { phase: "network" },
      ask
    )
    await assessEngineer(
      w.ports.train,
      w.network.id,
      w.source.train.id,
      "station_failure",
      "run",
      { phase: "network" },
      ask
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(
      (await w.ports.store.eventsAfter(w.network.id, 0)).filter(
        (row) => row.event.type === "engineer.assessed"
      )
    ).toHaveLength(1)
  })
  it("records current failed outcomes atomically, builds history, and ignores duplicate reports", async () => {
    const w = await setup()
    const failure = vi.spyOn(w.ports.train.engineer, "stationFailure")
    await advanceTrain(w.ports.train, w.source.train.id)
    await advanceTrain(w.ports.train, w.source.train.id)
    const first = w.ports.runs[0]!
    const outcome = {
      stationId: first.stationId,
      runId: first.runId,
      result: {
        ok: false as const,
        phase: "dependencies",
        issues: [
          { kind: "station_failed" as const, detail: "Install timed out" },
        ],
      },
    }
    await recordStationOutcome(w.ports.train, w.source.train.id, outcome)
    await recordStationOutcome(w.ports.train, w.source.train.id, outcome)
    expect(failure).toHaveBeenCalledTimes(1)
    const station = (await w.ports.store.station(first.stationId))!.value
    const next = stationRunId(
      station,
      await w.ports.store.signalCount(station.id)
    )
    await recordStationOutcome(w.ports.train, w.source.train.id, {
      ...outcome,
      runId: next,
    })
    expect(failure.mock.calls[1]?.[0].context?.history).toMatchObject([
      {
        runId: first.runId,
        phase: "dependencies",
        allowance: "current",
        action: "retry",
        backoff: false,
      },
    ])
    expect(
      (await w.ports.store.eventsAfter(w.network.id, 0)).filter(
        (row) => row.event.type === "station.run_failed"
      )
    ).toHaveLength(2)
  })
  it("retains failure history as historical after explicit intervention", async () => {
    const w = await setup()
    await advanceTrain(w.ports.train, w.source.train.id)
    await advanceTrain(w.ports.train, w.source.train.id)
    const run = w.ports.runs[0]!
    vi.spyOn(w.ports.train.engineer, "stationFailure").mockResolvedValue({
      value: "escalate",
      confidence: 1,
    })
    await recordStationOutcome(w.ports.train, w.source.train.id, {
      stationId: run.stationId,
      runId: run.runId,
      result: {
        ok: false,
        issues: [{ kind: "station_failed", detail: "Persistent" }],
      },
    })
    expect(w.ports.wakes).toContain(w.receiver.train.id)
    await clearTrain(w.ports.train, w.source.train.id)
    const context = await w.ports.store.engineer.history(
      w.network.id,
      run.stationId
    )
    expect(context.history).toMatchObject([
      { runId: run.runId, allowance: "historical", phase: "unknown" },
    ])
  })
  it("includes current independent checks when required failures bypass Conductor review", async () => {
    const w = await setup()
    const revision = vi.spyOn(w.ports.train.engineer, "revision")
    const conductor = vi.spyOn(w.ports.train.conductor, "review")
    await advanceTrain(w.ports.train, w.source.train.id)
    await advanceTrain(w.ports.train, w.source.train.id)
    const run = w.ports.runs[0]!
    const outcome = await runStation(w.ports, run)
    if (!outcome.result.ok) throw new Error("Expected fake candidate")
    outcome.result.proposal.evidence.checks = [
      {
        name: "test",
        required: true,
        status: "failed",
        stdout: "password=leak\nAssertion failed",
        exitCode: 1,
      },
    ]
    await recordStationOutcome(w.ports.train, w.source.train.id, outcome)
    for (let i = 0; i < 3; i++)
      await advanceTrain(w.ports.train, w.source.train.id)
    expect(conductor).not.toHaveBeenCalled()
    expect(revision.mock.calls[0]?.[0].context?.checks).toMatchObject([
      {
        name: "test",
        status: "failed",
        stdout: "password=[redacted]\nAssertion failed",
      },
    ])
  })
  it("reports recovery backoff but leaves the Train's movement and budget unchanged", async () => {
    const w = await setup()
    vi.spyOn(w.ports.train.engineer, "stationFailure").mockResolvedValue({
      value: "wait",
      confidence: 1,
    })
    await advanceTrain(w.ports.train, w.source.train.id)
    await advanceTrain(w.ports.train, w.source.train.id)
    const run = w.ports.runs[0]!
    await recordStationOutcome(w.ports.train, w.source.train.id, {
      stationId: run.stationId,
      runId: run.runId,
      result: {
        ok: false,
        issues: [{ kind: "station_failed", detail: "Rate limited" }],
      },
    })
    await observeEngineer(w.ports.train, w.source.train.id)
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices?.[0]?.cause
    ).toBe("recovery")
    expect((await w.ports.store.station(run.stationId))!.value.retryCount).toBe(
      1
    )
    expect(
      (await w.ports.store.train(w.source.train.id))!.value.state.status
    ).toBe("in_transit")
  })
  it("keeps actual upstream Train blockage deterministic and abandoned dependencies blocked", async () => {
    const w = await setup()
    const source = (await w.ports.store.train(w.source.train.id))!
    const stopped = blockTrain(source.value, [
      { kind: "needs_user", detail: "Needs configuration" },
    ])
    if (!stopped.ok) throw new Error("Cannot stop source")
    await w.ports.store.commit(
      w.network.id,
      [{ kind: "train", train: stopped.value, version: source.version }],
      stopped.events
    )
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).not.toHaveBeenCalled()
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices
    ).toHaveLength(1)
    const loaded = (await w.ports.store.train(w.source.train.id))!
    const abandoned = sendToSiding(loaded.value, "Abandon source")
    if (!abandoned.ok) throw new Error("Cannot abandon source")
    await w.ports.store.commit(
      w.network.id,
      [{ kind: "train", train: abandoned.value, version: loaded.version }],
      abandoned.events
    )
    await advanceTrain(w.ports.train, w.receiver.train.id)
    expect(
      (await w.ports.store.train(w.receiver.train.id))!.value.state.status
    ).toBe("blocked")
  })
  it("keeps notice changes atomic during concurrent acknowledgment and resolution", async () => {
    const w = await setup()
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    const row = (
      await w.ports.store.engineer.notices(w.network.id, w.receiver.train.id)
    )[0]!
    const settled = await Promise.allSettled([
      w.ports.store.engineer.acknowledge(
        w.network.id,
        row.value.id,
        w.ports.train.now()
      ),
      w.ports.store.engineer.saveNotice(
        w.network.id,
        { ...row.value, resolvedAt: w.ports.train.now() },
        row.version,
        [
          {
            type: "dispatcher.engineer_notice_resolved",
            trainId: w.receiver.train.id,
            noticeId: row.value.id,
          },
        ]
      ),
    ])
    expect(settled.some((result) => result.status === "fulfilled")).toBe(true)
    const current = (
      await w.ports.store.engineer.notices(w.network.id, w.receiver.train.id)
    )[0]!
    expect(!!current.value.resolvedAt || !!current.value.acknowledgedAt).toBe(
      true
    )
    const lifecycle = (await w.ports.store.eventsAfter(w.network.id, 0)).filter(
      (row) =>
        row.event.type === "dispatcher.engineer_notice_acknowledged" ||
        row.event.type === "dispatcher.engineer_notice_resolved"
    )
    expect(lifecycle.length).toBe(current.version)
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices
    ).toEqual([])
  })
  it("fences and erases Engineer metadata with its network", async () => {
    const w = await setup()
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    const deletion = new NetworkDeletionStore(env.DB)
    await deletion.begin(w.network.id)
    await expect(
      w.ports.store.engineer.acknowledge(
        w.network.id,
        (await w.ports.store.engineer.notices(w.network.id))[0]!.value.id,
        w.ports.train.now()
      )
    ).rejects.toThrow()
    await deletion.erase(w.network.id, `terminus-${w.network.id}`)
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM engineer_notices WHERE network_id=?"
      )
        .bind(w.network.id)
        .first<{ n: number }>())!.n
    ).toBe(0)
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM engineer_assessments WHERE network_id=?"
      )
        .bind(w.network.id)
        .first<{ n: number }>())!.n
    ).toBe(0)
  })
  it("keeps a confident no quiet, reassesses later milestones and ignores routine polling", async () => {
    const w = await setup()
    w.notify.mockResolvedValue({ value: false, confidence: 0.95 })
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    w.time(40)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).toHaveBeenCalledTimes(1)
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices
    ).toEqual([])
    w.time(60)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    w.time(120)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    w.time(240)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    expect(w.notify).toHaveBeenCalledTimes(4)
  })
  it("leaves first actionable returns routine and reports repeated returns", async () => {
    const w = await setup()
    await advanceTrain(w.ports.train, w.source.train.id)
    await advanceTrain(w.ports.train, w.source.train.id)
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = w.ports.runs.at(-1)!
      const outcome = await runStation(w.ports, run)
      if (!outcome.result.ok) throw new Error("Expected candidate")
      outcome.result.proposal.evidence.checks = [
        { name: "test", required: true, status: "failed" },
      ]
      await recordStationOutcome(w.ports.train, w.source.train.id, outcome)
      for (let i = 0; i < (attempt === 0 ? 3 : 2); i++)
        await advanceTrain(w.ports.train, w.source.train.id)
      await observeEngineer(w.ports.train, w.source.train.id)
      expect(w.notify).toHaveBeenCalledTimes(attempt)
      if (attempt === 0) await advanceTrain(w.ports.train, w.source.train.id)
    }
    expect(
      (await w.ports.store.snapshot(w.network.id))!.engineerNotices?.[0]?.cause
    ).toBe("recovery")
  })
  it("can report a new incident after acknowledged work makes progress", async () => {
    const w = await setup()
    w.time(30)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    const notice = (await w.ports.store.snapshot(w.network.id))!
      .engineerNotices![0]!
    await w.ports.store.engineer.acknowledge(
      w.network.id,
      notice.id,
      w.ports.train.now()
    )
    await advanceTrain(w.ports.train, w.source.train.id)
    w.ports.train.now = () => new Date().toISOString()
    await observeEngineer(w.ports.train, w.receiver.train.id)
    w.time(61)
    await observeEngineer(w.ports.train, w.receiver.train.id)
    const next = (await w.ports.store.snapshot(w.network.id))!
      .engineerNotices![0]!
    expect(next.id).not.toBe(notice.id)
    expect(next.acknowledgedAt).toBeUndefined()
  })
})
