import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import {
  drive,
  manifest,
  runStation,
  seedLine,
  seedNetwork,
  testPorts,
  type TestPorts,
} from "../../test/fixtures"
import {
  advanceTrain,
  recordStationOutcome,
  recordIntegrationOutcome,
} from "./train-operations"
import {
  prepareIntegration,
  promoteIntegration,
  failIntegration,
  type IntegrationPorts,
} from "./integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import { removeStation } from "../agents/dispatcher"

const integration = (p: TestPorts): IntegrationPorts => ({
  store: p.store,
  repositories: p.train.repositories,
  validator: new FakeIntegrationValidator(),
  conductorForTrain: async () => p.train.conductor,
})
async function acceptNext(p: TestPorts, id: string) {
  for (let i = 0; i < 15; i++) {
    const t = await p.store.train(id)
    const before = t!.value.carIds.length
    const move = await advanceTrain(p.train, id)
    if (move.kind === "await_station") {
      const run = p.runs.find((r) => r.runId === move.runId)!
      await recordStationOutcome(p.train, id, await runStation(p, run))
    }
    const after = await p.store.train(id)
    if (after!.value.carIds.length > before) return
  }
  throw new Error("No Car accepted")
}
async function setup() {
  const p = testPorts(),
    n = await seedNetwork(p)
  const source = await seedLine(p, n.id, {
    name: "Source",
    stations: ["a1", "a2", "a3"].map((key) => ({
      key,
      name: key,
      manifest: manifest(),
    })),
  })
  const receiver = await seedLine(p, n.id, {
    name: "Receiver",
    stations: [{ key: "b1", name: "B1", manifest: manifest() }],
    route: [
      {
        kind: "crossing",
        source: { kind: "existing", stationId: source.stations[1]!.id },
      },
      { kind: "station", key: "b1" },
    ],
  })
  return { p, n, source, receiver }
}
async function ready() {
  const w = await setup()
  await acceptNext(w.p, w.source.train.id)
  await acceptNext(w.p, w.source.train.id)
  const move = await drive(w.p, w.receiver.train.id)
  if (move.kind !== "await_integration") throw new Error("No pickup attempt")
  return { ...w, id: move.integrationId }
}
async function pickup(w: Awaited<ReturnType<typeof ready>>) {
  const ports = integration(w.p)
  await prepareIntegration(ports, w.id)
  const result = await promoteIntegration(ports, w.id)
  await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
    integrationId: w.id,
    result,
  })
  return result
}
describe("Crossing orchestration", () => {
  it("waits for acceptance, freezes A2, excludes A3 and never runs source work twice", async () => {
    const w = await setup()
    expect((await drive(w.p, w.receiver.train.id)).kind).toBe("await_wake")
    await acceptNext(w.p, w.source.train.id)
    expect((await drive(w.p, w.receiver.train.id)).kind).toBe("await_wake")
    await acceptNext(w.p, w.source.train.id)
    const cp = await w.p.store.checkpoint(w.source.stations[1]!.id)
    expect(cp?.carIds).toHaveLength(2)
    await acceptNext(w.p, w.source.train.id)
    expect(await w.p.store.checkpoint(w.source.stations[1]!.id)).toEqual(cp)
    const move = await drive(w.p, w.receiver.train.id)
    expect(move.kind).toBe("await_integration")
    if (move.kind !== "await_integration") throw new Error()
    expect(await pickup({ ...w, id: move.integrationId })).toMatchObject({
      ok: true,
    })
    const received = (await w.p.store.train(w.receiver.train.id))!.value
    expect(received.carIds).toHaveLength(2)
    const snapshot = (await w.p.store.snapshot(w.n.id))!
    expect(
      snapshot.cars
        .filter((c) => c.trainId === received.id)
        .map((c) => c.originCarId)
    ).toEqual(cp?.carIds)
    await drive(w.p, received.id)
    const workspace = (await w.p.store.station(w.receiver.stations[0]!.id))!
      .value
    expect(workspace.state.status).toBe("complete")
    const own = snapshot.crossings![0]!
    expect(own.state.status).toBe("complete")
    expect(
      w.p.runs.filter((r) => r.stationId === w.source.stations[1]!.id)
    ).toHaveLength(1)
    expect(
      (await w.p.store.train(w.source.train.id))!.value.carIds
    ).toHaveLength(3)
  })
  it("makes duplicated outcomes harmless and next Station baseline include imported work", async () => {
    const w = await ready()
    const result = await pickup(w)
    await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
      integrationId: w.id,
      result,
    })
    expect(
      (await w.p.store.train(w.receiver.train.id))!.value.carIds
    ).toHaveLength(2)
    await advanceTrain(w.p.train, w.receiver.train.id)
    await advanceTrain(w.p.train, w.receiver.train.id)
    const run = w.p.runs.find((r) => r.trainId === w.receiver.train.id)!
    await runStation(w.p, run)
    const station = (await w.p.store.station(run.stationId))!.value
    expect(station.state).toMatchObject({
      workspace: { baseCommit: result.ok ? result.mergeCommit : "" },
    })
  })
  it("keeps receiving review separate, blocks rejection and retries explicitly", async () => {
    const w = await ready()
    w.p.train.conductor.reviewCrossing = vi.fn().mockResolvedValue({
      verdict: "return",
      summary: "Incompatible contract",
      findings: ["Fix consumer"],
    })
    await prepareIntegration(integration(w.p), w.id)
    const result = await promoteIntegration(integration(w.p), w.id)
    await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
      integrationId: w.id,
      result,
    })
    expect(
      (await w.p.store.train(w.receiver.train.id))!.value.state.status
    ).toBe("blocked")
    expect(
      (await w.p.store.station(w.source.stations[1]!.id))!.value.state.status
    ).toBe("complete")
    const c = (await w.p.store.crossings(w.n.id))[0]!
    const loaded = (await w.p.store.crossing(c.id))!
    await w.p.store.commit(
      w.n.id,
      [
        {
          kind: "crossing",
          crossing: { ...c, retryRequested: true },
          version: loaded.version,
        },
      ],
      []
    )
    await advanceTrain(w.p.train, w.receiver.train.id)
    const move = await drive(w.p, w.receiver.train.id)
    expect(move.kind).toBe("await_integration")
    expect(await w.p.store.crossingAttempts(c.id)).toHaveLength(2)
    expect((await w.p.store.integration(w.id))?.review?.summary).toBe(
      "Incompatible contract"
    )
  })
  it("protects source removal and uses per-target concurrent reservations", async () => {
    const w = await ready()
    await expect(
      removeStation(w.p.dispatcher, w.n.id, w.source.stations[1]!.id, {
        reason: "remove",
      })
    ).rejects.toThrow()
    await drive(w.p, w.source.train.id)
    await advanceTrain(w.p.train, w.source.train.id)
    expect((await w.p.store.latestIntegration(w.source.train.id))?.status).toBe(
      "cleared"
    )
    expect((await w.p.store.integration(w.id))?.status).toBe("cleared")
  })
  it("reconciles successful pushes before applying newly added holds", async () => {
    const w = await ready(),
      ports = integration(w.p)
    await prepareIntegration(ports, w.id)
    const attempt = (await w.p.store.integration(w.id))!
    await w.p.store.recordIntegrationReview(
      w.id,
      { verdict: "accept", summary: "Accepted", findings: [], model: "fake" },
      "diff"
    )
    vi.spyOn(ports.repositories, "head").mockResolvedValue(
      attempt.candidate!.headCommit
    )
    const result = await failIntegration(ports, w.id, "Lost acknowledgement")
    expect(result.ok).toBe(true)
    await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
      integrationId: w.id,
      result,
    })
    expect(
      (await w.p.store.train(w.receiver.train.id))!.value.carIds
    ).toHaveLength(2)
  })
  it("blocks failed checks without receiving Conductor review", async () => {
    const w = await ready(),
      ports = integration(w.p)
    ports.validator.validate = vi.fn().mockResolvedValue({
      checks: [{ name: "test", required: true, status: "failed" }],
    })
    const review = vi.spyOn(w.p.train.conductor, "reviewCrossing")
    await prepareIntegration(ports, w.id)
    const result = (await w.p.store.integration(w.id))!.result!
    await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
      integrationId: w.id,
      result,
    })
    expect(review).not.toHaveBeenCalled()
    expect(
      (await w.p.store.train(w.receiver.train.id))!.value.state.status
    ).toBe("blocked")
  })
})

it("retains own Cars and copies only missing originals at later checkpoints", async () => {
  const w = await setup()
  await drive(w.p, w.source.train.id)
  const receiver = await seedLine(w.p, w.n.id, {
    name: "Two pickups",
    stations: [{ key: "own", name: "Own task", manifest: manifest() }],
    route: [
      {
        kind: "crossing",
        source: { kind: "existing", stationId: w.source.stations[0]!.id },
      },
      { kind: "station", key: "own" },
      {
        kind: "crossing",
        source: { kind: "existing", stationId: w.source.stations[1]!.id },
      },
    ],
  })
  for (let i = 0; i < 2; i++) {
    const move = await drive(w.p, receiver.train.id)
    if (move.kind !== "await_integration") throw new Error("No pickup")
    await pickup({ ...w, receiver, id: move.integrationId })
  }
  const train = (await w.p.store.train(receiver.train.id))!.value,
    snapshot = (await w.p.store.snapshot(w.n.id))!
  expect(train.carIds).toHaveLength(3)
  const cars = snapshot.cars.filter((c) => c.trainId === train.id)
  expect(cars.filter((c) => c.originCarId)).toHaveLength(2)
  expect(cars.map((c) => c.position)).toEqual([1, 2, 3])
  expect(
    snapshot
      .crossings!.filter((c) => c.lineId === train.lineId)
      .map((c) =>
        c.state.status === "complete" ? c.state.copiedCarIds.length : -1
      )
  ).toEqual([1, 1])
})
it("blocks abandoned sources and lets the receiving Workflow apply siding", async () => {
  const w = await setup()
  await w.p.store.requestSiding(w.source.train.id, "Abandon source")
  await advanceTrain(w.p.train, w.source.train.id)
  await drive(w.p, w.receiver.train.id)
  expect((await w.p.store.train(w.receiver.train.id))!.value.state.status).toBe(
    "blocked"
  )
  await w.p.store.requestSiding(w.receiver.train.id, "Abandon dependency")
  expect(await advanceTrain(w.p.train, w.receiver.train.id)).toEqual({
    kind: "finished",
    status: "siding",
  })
})
it("defers promotion on a new hold and never requests human unloading approval at pickup", async () => {
  const w = await ready(),
    ports = integration(w.p)
  const policy = (await w.p.store.unloadPolicy(w.receiver.train.id))!
  await w.p.store.commit(
    w.n.id,
    [
      {
        kind: "unload_policy",
        policy: { trainId: w.receiver.train.id, mode: "human_approval" },
        version: policy.version,
      },
    ],
    []
  )
  await prepareIntegration(ports, w.id)
  await w.p.store.commit(
    w.n.id,
    [
      {
        kind: "hold",
        hold: {
          id: "hold",
          kind: "user",
          scope: { kind: "network" },
          note: "Stop",
        },
      },
    ],
    []
  )
  const result = await promoteIntegration(ports, w.id)
  expect(result).toMatchObject({ ok: false, holds: [{ kind: "user_hold" }] })
  await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
    integrationId: w.id,
    result,
  })
  expect((await w.p.store.train(w.receiver.train.id))!.value.state.status).toBe(
    "held"
  )
  expect(
    (await w.p.store.train(w.receiver.train.id))!.value.carIds
  ).toHaveLength(0)
})
it("retains an uncertain push reservation and refuses abandonment until explicit recovery", async () => {
  const w = await ready(),
    ports = integration(w.p)
  await prepareIntegration(ports, w.id)
  await w.p.store.recordIntegrationReview(
    w.id,
    { verdict: "accept", summary: "Accepted", findings: [], model: "fake" },
    "diff"
  )
  vi.spyOn(ports.repositories, "head").mockRejectedValue(
    new Error("Cannot read remote")
  )
  await expect(
    failIntegration(ports, w.id, "Push outcome unknown")
  ).rejects.toThrow()
  const result = await w.p.store.interruptIntegration(w.id, "Cannot reconcile")
  await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
    integrationId: w.id,
    result,
  })
  expect(await w.p.store.requestSiding(w.receiver.train.id, "Stop")).toBe(false)
  await w.p.store.retryIntegration(w.id)
  const loaded = (await w.p.store.crossing(
    (await w.p.store.crossings(w.n.id))[0]!.id
  ))!
  await w.p.store.commit(
    w.n.id,
    [
      {
        kind: "crossing",
        crossing: { ...loaded.value, retryRequested: true },
        version: loaded.version,
      },
    ],
    []
  )
  await advanceTrain(w.p.train, w.receiver.train.id)
  ports.repositories.head = async () =>
    (await w.p.store.integration(w.id))!.candidate!.headCommit
  const recovered = await promoteIntegration(ports, w.id)
  expect(recovered.ok).toBe(true)
  await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
    integrationId: w.id,
    result: recovered,
  })
  expect(
    (await w.p.store.train(w.receiver.train.id))!.value.carIds
  ).toHaveLength(2)
})

it("reviews an already-present checkpoint with an empty diff before completing pickup", async () => {
  const w = await ready(),
    ports = integration(w.p),
    input = (await w.p.store.integration(w.id))!.input
  ports.repositories.prepareIntegration = async () => ({
    ok: true,
    candidate: { repoId: w.id, headCommit: input.terminusCommit },
  })
  ports.repositories.head = async () => input.terminusCommit
  ports.repositories.inspectIntegration = async () => ({
    diff: "",
    changedPaths: [],
  })
  const review = vi.spyOn(w.p.train.conductor, "reviewCrossing")
  await prepareIntegration(ports, w.id)
  const result = await promoteIntegration(ports, w.id)
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({
      diff: "",
      targetCommit: input.terminusCommit,
      candidateCommit: input.terminusCommit,
    })
  )
  expect(result.ok).toBe(true)
  await recordIntegrationOutcome(w.p.train, w.receiver.train.id, {
    integrationId: w.id,
    result,
  })
  expect(
    (await w.p.store.train(w.receiver.train.id))!.value.carIds
  ).toHaveLength(2)
})

it("reconstructs a legacy Station checkpoint from its accepted Car after the source advances", async () => {
  const w = await setup()
  await acceptNext(w.p, w.source.train.id)
  await acceptNext(w.p, w.source.train.id)
  const original = await w.p.store.checkpoint(w.source.stations[1]!.id)
  await acceptNext(w.p, w.source.train.id)
  await env.DB.prepare("DELETE FROM station_checkpoints WHERE id = ?")
    .bind(w.source.stations[1]!.id)
    .run()
  const move = await drive(w.p, w.receiver.train.id)
  expect(move.kind).toBe("await_integration")
  expect(await w.p.store.checkpoint(w.source.stations[1]!.id)).toEqual(original)
})

it("imports chained checkpoints with original and immediate-source provenance intact", async () => {
  const w = await ready()
  await pickup(w)
  await acceptNext(w.p, w.receiver.train.id)
  const b = (await w.p.store.train(w.receiver.train.id))!.value
  const c = await seedLine(w.p, w.n.id, {
    name: "Third Line",
    stations: [{ key: "c1", name: "C1", manifest: manifest() }],
    route: [
      {
        kind: "crossing",
        source: { kind: "existing", stationId: w.receiver.stations[0]!.id },
      },
      { kind: "station", key: "c1" },
    ],
  })
  const move = await drive(w.p, c.train.id)
  if (move.kind !== "await_integration") throw new Error("No chained pickup")
  await pickup({ ...w, receiver: c, id: move.integrationId })
  const snapshot = (await w.p.store.snapshot(w.n.id))!
  const inherited = snapshot.cars.filter((car) => car.trainId === c.train.id)
  expect(inherited).toHaveLength(3)
  expect(inherited.map((car) => car.sourceCarId)).toEqual(b.carIds)
  expect(inherited.slice(0, 2).map((car) => car.originCarId)).toEqual(
    (await w.p.store.checkpoint(w.source.stations[1]!.id))!.carIds
  )
})
