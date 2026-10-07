import { describe, it, expect, vi } from "vitest"
import { env } from "cloudflare:test"
import { drive, manifest, seedNetwork, testPorts } from "../../test/fixtures"
import { layJunction } from "../agents/junctions"
import {
  advanceJunction,
  reviewJunctionFeature,
  type JunctionPorts,
} from "./junction-operations"
import { advanceTrain, recordIntegrationOutcome } from "./train-operations"
import {
  prepareIntegration,
  promoteIntegration,
} from "./integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"

/** One Junction Workflow iteration, including the feature review step it runs. */
async function advance(ports: JunctionPorts, id: string) {
  const move = await advanceJunction(ports, id)
  if (move !== "review") return move
  await reviewJunctionFeature(ports, id)
  return "moved" as const
}
async function setup(stops = true) {
  const p = testPorts(),
    network = await seedNetwork(p)
  const ports: JunctionPorts = {
    ...p.dispatcher,
    startJunction: async () => {},
    wakeJunction: async () => {},
    startIntegration: async () => {},
    conductor: p.train.conductor,
    validator: new FakeIntegrationValidator(),
    conductorForTrain: async () => p.train.conductor,
  }
  const request = {
    requestId: crypto.randomUUID(),
    name: "Feature",
    brief: {
      goal: "Complete feature",
      scope: ["src/"],
      contracts: [],
      invariants: [],
      acceptanceCriteria: ["Works together"],
      validation: [{ name: "feature", command: ["npm", "test"] }],
    },
    incoming: [
      { name: "A", stations: [{ key: "a", name: "A", manifest: manifest() }] },
      { name: "B", stations: [{ key: "b", name: "B", manifest: manifest() }] },
    ],
    outgoing: {
      name: "Feature delivery",
      stations: stops
        ? [{ key: "out", name: "Wire feature", manifest: manifest() }]
        : [],
    },
  }
  const j = await layJunction(ports, network.id, request, "fake")
  return { p, ports, network, j, request }
}
async function converge(w: Awaited<ReturnType<typeof setup>>) {
  for (const id of w.j.incomingTrainIds) {
    await drive(w.p, id)
    await advanceTrain(w.p.train, id)
  }
  for (let n = 0; n < 15; n++) {
    await advance(w.ports, w.j.id)
    const active = (await w.p.store.integrations(w.network.id)).find(
      (a) => a.input.purpose === "junction" && !a.result
    )
    if (active) {
      await prepareIntegration(w.ports, active.input.id)
      await promoteIntegration(w.ports, active.input.id)
    }
    if ((await w.p.store.junction(w.j.id))!.value.state.status === "ready")
      return
  }
  throw new Error("Junction did not become ready")
}
describe("Junction convergence", () => {
  it("leaves feature review to its own step, verifying the Junction head with its feature checks", async () => {
    const w = await setup()
    const review = vi.spyOn(w.p.train.conductor, "reviewJunction")
    for (const id of w.j.incomingTrainIds) {
      await drive(w.p, id)
      await advanceTrain(w.p.train, id)
    }
    let move = await advanceJunction(w.ports, w.j.id)
    for (let n = 0; move !== "review" && n < 15; n++) {
      const active = (await w.p.store.integrations(w.network.id)).find(
        (a) => a.input.purpose === "junction" && !a.result
      )
      if (active) {
        await prepareIntegration(w.ports, active.input.id)
        await promoteIntegration(w.ports, active.input.id)
      }
      move = await advanceJunction(w.ports, w.j.id)
    }
    expect(move).toBe("review")
    const inputReviews = review.mock.calls.length
    expect(await advanceJunction(w.ports, w.j.id)).toBe("review")
    expect(review).toHaveBeenCalledTimes(inputReviews)

    await reviewJunctionFeature(w.ports, w.j.id)
    const j = (await w.p.store.junction(w.j.id))!.value
    expect(j.state.status).toBe("ready")
    const [input, context] = review.mock.calls.at(-1)!
    expect(input.kind).toBe("junction_feature")
    expect(context).toEqual({
      repoId: j.repoId,
      validation: expect.arrayContaining(w.request.brief.validation),
    })
    // A repeated step does nothing once the feature is reviewed.
    await reviewJunctionFeature(w.ports, w.j.id)
    expect(review).toHaveBeenCalledTimes(inputReviews + 1)
  })

  it("defers promotion when an input becomes held after clearance and resumes automatically", async () => {
    const w = await setup(false)
    for (const id of w.j.incomingTrainIds) {
      await drive(w.p, id)
      await advanceTrain(w.p.train, id)
    }
    await advance(w.ports, w.j.id)
    const active = (await w.p.store.integrations(w.network.id))[0]!
    const { placeHold, releaseHold } = await import("../agents/dispatcher")
    const hold = await placeHold(w.p.dispatcher, w.network.id, {
      kind: "user",
      scope: { kind: "train", trainId: active.input.trainId },
      note: "Pause promotion",
    })
    await advanceTrain(w.p.train, active.input.trainId)
    expect(
      (await w.p.store.train(active.input.trainId))!.value.state.status
    ).toBe("held")
    await prepareIntegration(w.ports, active.input.id)
    const deferred = await promoteIntegration(w.ports, active.input.id)
    expect(deferred).toMatchObject({
      ok: false,
      holds: [{ kind: "user_hold" }],
    })
    await advance(w.ports, w.j.id)
    expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe(
      "collecting"
    )
    expect((await w.p.store.junction(w.j.id))!.value.headCommit).toBe(
      w.j.terminusBaseline
    )
    await releaseHold(w.p.dispatcher, w.network.id, hold.id)
    await advanceTrain(w.p.train, active.input.trainId)
    await converge(w)
    expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe("ready")
  })
  it("concurrent creation retries persist one complete topology and reject request reuse", async () => {
    const w = await setup(false)
    const request = { ...w.request, requestId: crypto.randomUUID() }
    const [a, b] = await Promise.all([
      layJunction(w.ports, w.network.id, request, "fake"),
      layJunction(w.ports, w.network.id, request, "fake"),
    ])
    expect(a.id).toBe(b.id)
    const snapshot = (await w.p.store.snapshot(w.network.id))!
    expect(snapshot.junctions).toHaveLength(2)
    expect(
      snapshot.trains.filter((t) => a.incomingTrainIds.includes(t.train.id))
    ).toHaveLength(2)
    expect(snapshot.trains.some((t) => t.train.id === a.outgoingTrainId)).toBe(
      false
    )
    await expect(
      layJunction(
        w.ports,
        w.network.id,
        { ...request, name: "Changed feature" },
        "fake"
      )
    ).rejects.toThrow(/different feature/)
  })
  it("recovers release startup after durable commit without duplicate Trains, Cars or approvals", async () => {
    const w = await setup(false)
    await converge(w)
    const ready = (await w.p.store.junction(w.j.id))!.value
    const { placeHold, releaseHold } = await import("../agents/dispatcher")
    const hold = await placeHold(w.p.dispatcher, w.network.id, {
      kind: "user",
      scope: { kind: "line", lineId: ready.outgoingLineId },
      note: "Wait for release",
    })
    await Promise.all([
      w.p.store.commandJunction(w.j.id, { commit: ready.headCommit }),
      w.p.store.commandJunction(w.j.id, { commit: ready.headCommit }),
    ])
    await advance(w.ports, w.j.id)
    expect(await w.p.store.train(ready.outgoingTrainId)).toBeNull()
    expect(
      (await w.p.store.snapshot(w.network.id))!.junctionApprovals
    ).toContainEqual({ junctionId: w.j.id, commit: ready.headCommit })
    await releaseHold(w.p.dispatcher, w.network.id, hold.id)
    w.ports.startTrain = vi
      .fn()
      .mockRejectedValueOnce(new Error("Notification lost"))
      .mockResolvedValue(undefined)
    await expect(advance(w.ports, w.j.id)).rejects.toThrow(/Notification lost/)
    expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe(
      "released"
    )
    await advance(w.ports, w.j.id)
    const snapshot = (await w.p.store.snapshot(w.network.id))!
    expect(
      snapshot.trains.filter((t) => t.train.id === ready.outgoingTrainId)
    ).toHaveLength(1)
    expect(
      snapshot.cars.filter((c) => c.trainId === ready.outgoingTrainId)
    ).toHaveLength(2)
    const events = await w.p.store.eventsAfter(w.network.id, 0)
    expect(
      events.filter((e) => e.event.type === "junction.release_approved")
    ).toHaveLength(1)
    expect(
      events.filter((e) => e.event.type === "junction.released")
    ).toHaveLength(1)
  })
  it("keeps all feature work outside Terminus, releases once, and runs downstream work from the assembled snapshot", async () => {
    const w = await setup()
    await converge(w)
    const ready = (await w.p.store.junction(w.j.id))!.value
    expect(ready.inputs).toHaveLength(2)
    expect(await w.p.store.train(w.j.outgoingTrainId)).toBeNull()
    expect((await w.p.store.network(w.network.id))!.terminusCommit).toBe(
      w.j.terminusBaseline
    )
    for (const id of w.j.incomingTrainIds) await advanceTrain(w.p.train, id)
    expect(
      (await w.p.store.train(w.j.incomingTrainIds[0]!))!.value.state
    ).toMatchObject({
      status: "unloaded",
      destination: { kind: "junction", junctionId: w.j.id },
    })
    await expect(
      w.p.store.commandJunction(w.j.id, { commit: "stale" })
    ).rejects.toThrow()
    await w.p.store.commandJunction(w.j.id, { commit: ready.headCommit })
    await advance(w.ports, w.j.id)
    await advance(w.ports, w.j.id)
    const output = (await w.p.store.train(w.j.outgoingTrainId))!.value
    expect(output.terminusBaseline).toBe(w.j.terminusBaseline)
    expect(output.headCommit).toBe(ready.headCommit)
    expect(output.carIds).toHaveLength(2)
    expect(output.state).toMatchObject({
      status: "ready",
      at: { kind: "junction" },
    })
    await drive(w.p, output.id)
    const own = (await w.p.store.snapshot(w.network.id))!.cars.find(
      (c) => c.trainId === output.id && !c.junctionId
    )!
    expect(own.sourceCommit).toBe(ready.headCommit)
    await advanceTrain(w.p.train, output.id)
    const attempt = (await w.p.store.latestIntegration(output.id))!
    await prepareIntegration(w.ports, attempt.input.id)
    const result = await promoteIntegration(w.ports, attempt.input.id)
    await recordIntegrationOutcome(w.p.train, output.id, {
      integrationId: attempt.input.id,
      result,
    })
    expect((await w.p.store.train(output.id))!.value.state.status).toBe(
      "unloaded"
    )
    expect((await w.p.store.network(w.network.id))!.terminusCommit).not.toBe(
      w.j.terminusBaseline
    )
  })
  it("retains target exclusion until acknowledgement, and duplicate acknowledgements do not duplicate inputs", async () => {
    const w = await setup(false)
    for (const id of w.j.incomingTrainIds) {
      await drive(w.p, id)
      await advanceTrain(w.p.train, id)
    }
    await advance(w.ports, w.j.id)
    const active = (await w.p.store.integrations(w.network.id))[0]!
    await prepareIntegration(w.ports, active.input.id)
    await promoteIntegration(w.ports, active.input.id)
    expect((await w.p.store.integration(active.input.id))!.status).toBe(
      "prepared"
    )
    await expect(
      env.DB.prepare(
        "UPDATE junctions SET record=json_set(record,'$.headCommit','unreviewed'),version=version+1 WHERE id=?"
      )
        .bind(w.j.id)
        .run()
    ).rejects.toThrow()
    await advance(w.ports, w.j.id)
    expect((await w.p.store.integration(active.input.id))!.status).toBe(
      "completed"
    )
    await advance(w.ports, w.j.id)
    expect((await w.p.store.junction(w.j.id))!.value.inputs).toHaveLength(1)
  })
  it("supports direct outgoing routes and feature validation blockers", async () => {
    const w = await setup(false)
    await converge(w)
    const ready = (await w.p.store.junction(w.j.id))!.value
    await w.p.store.commandJunction(w.j.id, { commit: ready.headCommit })
    await advance(w.ports, w.j.id)
    await advanceTrain(w.p.train, w.j.outgoingTrainId)
    expect(
      (await w.p.store.train(w.j.outgoingTrainId))!.value.state.status
    ).toBe("returning")
    const x = await setup(false)
    x.ports.conductor = {
      ...x.ports.conductor,
      model: "fake",
      review: async () => ({ verdict: "accept", summary: "ok", findings: [] }),
      reviewJunction: vi.fn().mockResolvedValue({
        verdict: "return",
        summary: "Feature contract missing",
        findings: [],
      }),
    }
    await expect(converge(x)).rejects.toThrow()
    expect((await x.p.store.junction(x.j.id))!.value.state.status).toBe(
      "blocked"
    )
    expect(
      (await x.p.store.junction(x.j.id))!.value.acceptance?.review.summary
    ).toBe("Feature contract missing")
  })
  it("rejects Crossings across boundaries and protects frozen membership", async () => {
    const w = await setup()
    expect(await layJunction(w.ports, w.network.id, w.request, "fake")).toEqual(
      w.j
    )
    const request = {
      ...w.request,
      requestId: crypto.randomUUID(),
      incoming: w.request.incoming.map((l, i) =>
        i
          ? {
              ...l,
              route: [
                {
                  kind: "crossing" as const,
                  source: {
                    kind: "existing" as const,
                    stationId: `${w.j.id}-l0-s0`,
                  },
                },
                { kind: "station" as const, key: "b" },
              ],
            }
          : l
      ),
    }
    await expect(
      layJunction(w.ports, w.network.id, request, "fake")
    ).rejects.toThrow(/boundar/)
  })
})

it("recovers an uncertain push through the same reservation and acknowledges before abandonment", async () => {
  const w = await setup(false)
  const id = w.j.incomingTrainIds[0]!
  await drive(w.p, id)
  await advanceTrain(w.p.train, id)
  await advance(w.ports, w.j.id)
  const a = (await w.p.store.integrations(w.network.id))[0]!
  await prepareIntegration(w.ports, a.input.id)
  await w.p.store.interruptIntegration(
    a.input.id,
    "Push acknowledgement unknown"
  )
  await advance(w.ports, w.j.id)
  expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe("blocked")
  await w.p.store.retryIntegration(a.input.id)
  await w.p.store.commandJunction(w.j.id, { retry: true })
  await advance(w.ports, w.j.id)
  expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe(
    "collecting"
  )
  await promoteIntegration(w.ports, a.input.id)
  await w.p.store.commandJunction(w.j.id, { reason: "cancel feature" })
  await advance(w.ports, w.j.id)
  expect((await w.p.store.integration(a.input.id))!.status).toBe("completed")
  await advanceTrain(w.p.train, id)
  await advance(w.ports, w.j.id)
  await advanceTrain(w.p.train, w.j.incomingTrainIds[1]!)
  expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe(
    "abandoned"
  )
  expect((await w.p.store.train(id))!.value.state.status).toBe("unloaded")
  expect(
    (await w.p.store.train(w.j.incomingTrainIds[1]!))!.value.state.status
  ).toBe("siding")
})

it("collects independent Junctions concurrently and skips a held first arrival", async () => {
  const w = await setup(false),
    second = await layJunction(
      w.ports,
      w.network.id,
      { ...w.request, requestId: crypto.randomUUID(), name: "Second feature" },
      "fake"
    )
  for (const id of [...w.j.incomingTrainIds, ...second.incomingTrainIds]) {
    await drive(w.p, id)
    await advanceTrain(w.p.train, id)
  }
  const { placeHold, releaseHold } = await import("../agents/dispatcher")
  const hold = await placeHold(w.p.dispatcher, w.network.id, {
    kind: "user",
    scope: { kind: "line", lineId: w.j.incomingLineIds[0]! },
    note: "Wait",
  })
  await advance(w.ports, w.j.id)
  await advance(w.ports, second.id)
  const active = (await w.p.store.integrations(w.network.id)).filter(
    (a) => a.status === "cleared"
  )
  expect(active).toHaveLength(2)
  expect(active[0]!.input.trainId).toBe(w.j.incomingTrainIds[1])
  for (const a of active) {
    await prepareIntegration(w.ports, a.input.id)
    await promoteIntegration(w.ports, a.input.id)
  }
  await advance(w.ports, w.j.id)
  await advance(w.ports, second.id)
  expect((await w.p.store.junction(w.j.id))!.value.inputs).toHaveLength(1)
  await releaseHold(w.p.dispatcher, w.network.id, hold.id)
  await converge(w)
  expect((await w.p.store.junction(w.j.id))!.value.state.status).toBe("ready")
  expect((await w.p.store.network(w.network.id))!.terminusCommit).toBe(
    w.j.terminusBaseline
  )
})

it("repairs a feature review failure without granting release permission", async () => {
  const w = await setup(false)
  const original = w.ports.conductor
  w.ports.conductor = {
    ...original,
    model: "fake",
    review: original.review.bind(original),
    reviewJunction: async () => ({
      verdict: "return",
      summary: "Feature contract missing",
      findings: [],
    }),
  }
  await expect(converge(w)).rejects.toThrow()
  const j = (await w.p.store.junction(w.j.id))!.value
  const { FakeTechnicianRunner, FakeRepairConductor } =
    await import("@terminus/agent-runtime")
  const { dispatchJunctionRepair, approveJunctionRepair } =
    await import("../agents/junction-repairs")
  const {
    prepareTechnician,
    runTechnician,
    validateTechnician,
    reviewTechnician,
  } = await import("./technician-operations")
  const technician = {
    ...w.p.dispatcher,
    runner: new FakeTechnicianRunner(),
    reviewer: new FakeRepairConductor(),
    validator: new FakeIntegrationValidator(),
    startRepair: async () => {},
  }
  await expect(
    dispatchJunctionRepair(technician, j.id, {
      failureId: `${j.id}-feature-${j.attempt}`,
    })
  ).rejects.toThrow(/bounded/)
  const repair = await dispatchJunctionRepair(technician, j.id, {
    failureId: `${j.id}-feature-${j.attempt}`,
    scope: ["src/feature.ts"],
  })
  await prepareTechnician(technician, repair.id)
  await runTechnician(technician, repair.id)
  await validateTechnician(technician, repair.id)
  await reviewTechnician(technician, repair.id)
  const reviewed = (await w.p.store.repair(repair.id))!.value
  if (reviewed.state.status !== "ready") throw new Error("Repair not ready")
  await expect(
    approveJunctionRepair(technician, repair.id, j.id, "stale")
  ).rejects.toThrow(/stale/)
  await approveJunctionRepair(
    technician,
    repair.id,
    j.id,
    reviewed.state.proposal.headCommit
  )
  w.ports.conductor = original
  await advance(w.ports, j.id)
  const active = (await w.p.store.integrations(w.network.id)).find(
    (a) => a.input.repairId === repair.id
  )!
  await prepareIntegration(w.ports, active.input.id)
  await promoteIntegration(w.ports, active.input.id)
  await advance(w.ports, j.id)
  expect((await w.p.store.repair(repair.id))!.value.state.status).toBe(
    "integrated"
  )
  await advance(w.ports, j.id)
  await advance(w.ports, j.id)
  const ready = (await w.p.store.junction(j.id))!.value
  expect(ready.state.status).toBe("ready")
  expect(ready.headCommit).not.toBe(j.headCommit)
  expect(await w.p.store.train(j.outgoingTrainId)).toBeNull()
  await expect(
    w.p.store.commandJunction(j.id, { commit: j.headCommit })
  ).rejects.toThrow()
})
