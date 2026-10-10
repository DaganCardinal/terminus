import {
  FakeConductor,
  FakeEngineer,
  FakeStationRunner,
  type Conductor,
  type EngineerAdvisor,
  type StationRunner,
} from "@terminus/agent-runtime"
import { describe, expect, it, vi } from "vitest"
import { domainEventSchema } from "@terminus/protocol"
import {
  drive,
  manifest,
  runStation,
  seedLine,
  seedNetwork,
  testPorts,
  type TestPorts,
} from "../../test/fixtures"
import { placeHold, releaseHold } from "../agents/dispatcher"
import {
  advanceTrain,
  clearTrain,
  failReview,
  recordStationOutcome,
  reviewStation,
} from "./train-operations"

async function eventTypes(ports: TestPorts, networkId: string) {
  const events = await ports.store.eventsAfter(networkId, 0)
  return events.map((envelope) => envelope.event.type)
}

async function trainState(ports: TestPorts, trainId: string) {
  return (await ports.store.train(trainId))!.value.state
}

async function retryFixture(returns = 100, engineer?: EngineerAdvisor) {
  const ports = testPorts({
    conductor: new FakeConductor({ returns }),
    engineer,
  })
  const network = await seedNetwork(ports)
  const laid = await seedLine(ports, network.id, {
    name: "Retry Line",
    stations: [
      {
        key: "a",
        name: "Retry Station",
        manifest: manifest({ expectedEvidence: ["test"] }),
      },
    ],
  })
  return { ports, network, ...laid }
}

describe("bounded Station revisions and Dispatcher alerts", () => {
  it("allows success on the third retry without escalating", async () => {
    const { ports, network, train } = await retryFixture(3)
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    expect(ports.runs).toHaveLength(4)
    const snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.cars).toHaveLength(1)
    expect(await eventTypes(ports, network.id)).not.toContain(
      "dispatcher.user_attention_requested"
    )
  })

  it("stops after the initial attempt plus three retries, persists the latest review and alerts the user once", async () => {
    const { ports, network, train, stations } = await retryFixture()
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(4)
    let snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.trains[0]).toMatchObject({
      signal: "red",
      train: {
        headCommit: train.headCommit,
        state: {
          status: "blocked",
          issues: [{ kind: "station_retries_exhausted" }],
        },
      },
    })
    expect(snapshot.cars).toEqual([])
    expect(snapshot.network.terminusCommit).toBe(network.terminusCommit)
    const station = snapshot.stations[0]!
    expect(station).toMatchObject({
      state: { status: "blocked" },
      retryCount: 3,
      revisionCount: 3,
      lastReview: {
        feedback: { findings: ["Revision 4 requested"] },
        proposal: {
          headCommit: `fake-${stations[0]!.id}-s1-r3`,
          evidence: {
            checks: expect.arrayContaining([
              { name: "test", required: true, status: "passed" },
            ]),
          },
        },
      },
    })
    const types = await eventTypes(ports, network.id)
    expect(types.slice(-4)).toEqual([
      "station.blocked",
      "train.blocked",
      "train.issue_raised",
      "dispatcher.user_attention_requested",
    ])
    const event = (await ports.store.eventsAfter(network.id, 0)).at(-1)!.event
    expect(domainEventSchema.parse(event)).toMatchObject({
      type: "dispatcher.user_attention_requested",
      trainId: train.id,
      stationId: station.id,
    })
    for (let i = 0; i < 3; i++)
      expect(await advanceTrain(ports.train, train.id)).toEqual({
        kind: "await_clear",
      })
    snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.lastSeq).toBe(
      (await ports.store.eventsAfter(network.id, 0)).at(-1)!.seq
    )
    expect(
      (await eventTypes(ports, network.id)).filter(
        (type) => type === "dispatcher.user_attention_requested"
      )
    ).toHaveLength(1)
    expect(ports.runs).toHaveLength(4)
  })

  it("bounds repeated required-check failures without calling the Conductor", async () => {
    const { ports, network, train } = await retryFixture()
    const run = ports.station.runner.run.bind(ports.station.runner)
    vi.spyOn(ports.station.runner, "run").mockImplementation(async (input) => {
      const result = await run(input)
      if (!result.ok) return result
      return {
        ok: true,
        proposal: {
          ...result.proposal,
          evidence: {
            checks: [{ name: "test", required: true, status: "failed" }],
          },
        },
      }
    })
    const review = vi.spyOn(ports.train.conductor, "review")
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(4)
    expect(review).not.toHaveBeenCalled()
    expect(
      (await ports.store.snapshot(network.id))!.stations[0]!.lastReview
    ).toMatchObject({
      feedback: { findings: ["test: failed"] },
      proposal: { evidence: { checks: [{ status: "failed" }] } },
    })
  })

  it.each([0, 1])(
    "honors a configured allowance of %i retries",
    async (maxRetries) => {
      const { ports, train } = await retryFixture()
      ports.train.stationMaxRetries = maxRetries
      expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
      expect(ports.runs).toHaveLength(maxRetries + 1)
    }
  )

  it("grants another bounded allowance only after explicit clearance, retaining history and feedback", async () => {
    const { ports, network, train, stations } = await retryFixture()
    const run = vi.spyOn(ports.station.runner, "run")
    await drive(ports, train.id)
    const before = (await ports.store.station(stations[0]!.id))!.value
    await clearTrain(ports.train, train.id)
    await clearTrain(ports.train, train.id)
    const restarted = (await ports.store.station(stations[0]!.id))!.value
    expect(restarted).toMatchObject({
      state: { status: "waiting" },
      retryCount: 0,
      revisionCount: 3,
      lastReview: before.lastReview,
    })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(8)
    expect(ports.runs[4]!.runId).toBe(`${stations[0]!.id}-s2-r3`)
    expect(run.mock.calls[4]![0].feedback).toEqual(before.lastReview!.feedback)
    const after = (await ports.store.station(stations[0]!.id))!.value
    expect(after).toMatchObject({ retryCount: 3, revisionCount: 6 })
    expect(after.lastReview!.workspace.repoId).not.toBe(
      before.lastReview!.workspace.repoId
    )
    expect(
      (await eventTypes(ports, network.id)).filter(
        (type) => type === "dispatcher.user_attention_requested"
      )
    ).toHaveLength(2)
  })

  it("recovers a lost escalation acknowledgement without duplicating alerts or starting another run", async () => {
    const { ports, network, train } = await retryFixture()
    const commit = ports.store.commit.bind(ports.store)
    vi.spyOn(ports.store, "commit").mockImplementation(async (...args) => {
      await commit(...args)
      if (
        args[2].some(
          (event) => event.type === "dispatcher.user_attention_requested"
        )
      )
        throw new Error("Lost escalation acknowledgement")
    })
    await expect(drive(ports, train.id)).rejects.toThrow(
      "Lost escalation acknowledgement"
    )
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(4)
    expect(
      (await eventTypes(ports, network.id)).filter(
        (type) => type === "dispatcher.user_attention_requested"
      )
    ).toHaveLength(1)
  })
})

/** A runner that fails its first `failures` runs, then works. */
function failingRunner(failures: number): StationRunner {
  const fake = new FakeStationRunner()
  let calls = 0
  return {
    config: fake.config,
    run: async (input) => {
      calls += 1
      if (calls <= failures)
        return {
          ok: false,
          issues: [
            {
              kind: "station_failed",
              detail: "Station run failed during harness: sandbox restarted",
            },
          ],
        }
      return fake.run(input)
    },
  }
}

describe("Engineer decisions", () => {
  it("retries a failed run as a new run, using up one automatic retry", async () => {
    const ports = testPorts({
      runner: failingRunner(1),
      engineer: new FakeEngineer({ stationFailure: "retry" }),
    })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    const id = stations[0]!.id
    expect(ports.runs.map((run) => run.runId).slice(0, 2)).toEqual([
      `${id}-s1-r0`,
      `${id}-s1-r0-f1`,
    ])
    expect((await ports.store.station(id))!.value).toMatchObject({
      state: { status: "complete" },
      retryCount: 1,
      runRetries: 1,
    })
    const types = await eventTypes(ports, network.id)
    expect(types).toContain("station.run_retried")
    expect(types).not.toContain("train.blocked")
  })

  it("asks the Train Workflow to pause before a retry the Engineer waits on", async () => {
    const ports = testPorts({
      runner: failingRunner(1),
      engineer: new FakeEngineer({ stationFailure: "wait" }),
    })
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    let move = await advanceTrain(ports.train, train.id)
    while (move.kind === "moved")
      move = await advanceTrain(ports.train, train.id)
    expect(move.kind).toBe("await_station")
    const outcome = await runStation(ports, ports.runs[0]!)
    expect(await recordStationOutcome(ports.train, train.id, outcome)).toEqual({
      backoff: true,
    })
    const event = (await ports.store.eventsAfter(network.id, 0)).at(-1)!.event
    expect(domainEventSchema.parse(event)).toMatchObject({
      type: "station.run_retried",
      backoff: true,
    })
  })

  it("never retries past the hard cap, whatever the model advises", async () => {
    const ports = testPorts({
      runner: failingRunner(100),
      engineer: new FakeEngineer({ stationFailure: "retry" }),
    })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(4)
    expect(ports.runs.at(-1)!.runId).toBe(`${stations[0]!.id}-s1-r0-f3`)
    expect(await trainState(ports, train.id)).toMatchObject({
      status: "blocked",
      issues: [{ kind: "station_failed" }],
    })
  })

  it("stops a revision loop early, keeping the feedback and alerting the user", async () => {
    const { ports, network, train, stations } = await retryFixture(
      100,
      new FakeEngineer({ revision: "escalate" })
    )
    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(ports.runs).toHaveLength(1)
    expect(await trainState(ports, train.id)).toMatchObject({
      status: "blocked",
      issues: [{ kind: "engineer_escalated" }],
    })
    expect((await ports.store.station(stations[0]!.id))!.value).toMatchObject({
      state: { status: "blocked" },
      revisionCount: 0,
      lastReview: { feedback: { findings: ["Revision 1 requested"] } },
    })
    expect((await eventTypes(ports, network.id)).at(-1)).toBe(
      "dispatcher.user_attention_requested"
    )
  })
})

describe("a Train on its Line", () => {
  it("runs every Station, with a revision, and returns to Terminus", async () => {
    const ports = testPorts({ conductor: new FakeConductor({ returns: 1 }) })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)

    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })

    const loaded = (await ports.store.train(train.id))!.value
    expect(loaded.state).toEqual({
      status: "returning",
      phase: "awaiting_clearance",
    })
    expect(loaded.carIds).toHaveLength(2)
    // The second Station was forked from the Train after the first Car.
    expect(ports.runs.map((run) => run.runId)).toEqual([
      `${stations[0]!.id}-s1-r0`,
      `${stations[0]!.id}-s1-r1`,
      `${stations[1]!.id}-s1-r0`,
      `${stations[1]!.id}-s1-r1`,
    ])
    expect(loaded.headCommit).toBe(`fake-${stations[1]!.id}-s1-r1`)

    const snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.cars.map((car) => car.stationId)).toEqual(
      stations.map((station) => station.id)
    )
    expect(snapshot.cars[1]!.sourceCommit).toBe(`fake-${stations[0]!.id}-s1-r1`)

    const types = await eventTypes(ports, network.id)
    expect(types.filter((type) => type === "station.returned")).toHaveLength(2)
    expect(types.filter((type) => type === "car.attached")).toHaveLength(2)
    expect(types.slice(-2)).toEqual([
      "train.returning",
      "terminus.integration_requested",
    ])
  })

  it("reuses the accepted verdict if D1 fails after the Train push", async () => {
    let reviews = 0
    const conductor: Conductor = {
      model: "spy",
      review: async () => {
        reviews += 1
        return {
          verdict: reviews === 1 ? "accept" : "return",
          summary: "Original review",
          findings: [],
        }
      },
    }
    const ports = testPorts({ conductor })
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id, {
      name: "One",
      stations: [{ key: "a", name: "A", manifest: manifest() }],
    })
    const commit = ports.store.commit.bind(ports.store)
    let interrupted = false
    vi.spyOn(ports.store, "commit").mockImplementation(async (...args) => {
      if (!interrupted && args[1].some((write) => write.kind === "car")) {
        interrupted = true
        throw new Error("D1 temporarily unavailable after push")
      }
      return commit(...args)
    })
    const push = vi.spyOn(ports.train.repositories, "fastForward")
    await expect(drive(ports, train.id)).rejects.toThrow("after push")
    expect(push).toHaveBeenCalledTimes(1)
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    expect(push).toHaveBeenCalledTimes(2)
    expect(reviews).toBe(1)
    const snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.cars).toHaveLength(1)
    expect(snapshot.cars[0]!.review).toMatchObject({
      summary: "Original review",
      model: "spy",
    })
  })

  it("is held by a dependency on another Line until it completes", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const red = await seedLine(ports, network.id)
    const blue = await seedLine(ports, network.id, {
      name: "Blue Line",
      stations: [
        {
          key: "x",
          name: "X",
          manifest: manifest({ dependencies: [red.stations[0]!.id] }),
        },
      ],
    })

    expect(await drive(ports, blue.train.id)).toEqual({ kind: "await_wake" })
    expect(await trainState(ports, blue.train.id)).toMatchObject({
      status: "held",
      reasons: [{ kind: "dependency", stationId: red.stations[0]!.id }],
    })

    await drive(ports, red.train.id)
    expect(ports.wakes).toContain(blue.train.id)
    expect(await drive(ports, blue.train.id)).toEqual({
      kind: "await_terminus",
    })
    expect(await eventTypes(ports, network.id)).toContain("train.released")
  })

  it("stops for a user hold and continues once it is released", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, line } = await seedLine(ports, network.id)
    const hold = await placeHold(ports.dispatcher, network.id, {
      kind: "user",
      scope: { kind: "line", lineId: line.id },
      note: "Wait for review",
    })

    expect(await drive(ports, train.id)).toEqual({ kind: "await_wake" })
    expect(await drive(ports, train.id)).toEqual({ kind: "await_wake" })

    await releaseHold(ports.dispatcher, network.id, hold.id)
    expect(ports.wakes).toContain(train.id)
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
  })

  it("blocks when a Station Agent fails, and retries once cleared", async () => {
    let calls = 0
    const fake = new FakeStationRunner()
    const flaky: StationRunner = {
      config: fake.config,
      run: async (input) => {
        calls += 1
        if (calls === 1) {
          return {
            ok: false,
            issues: [{ kind: "station_failed", detail: "agent crashed" }],
          }
        }
        return fake.run(input)
      },
    }
    const ports = testPorts({ runner: flaky })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)

    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(await trainState(ports, train.id)).toMatchObject({
      status: "blocked",
      issues: [{ kind: "station_failed" }],
      resume: { status: "ready", at: { kind: "depot" } },
    })
    expect(
      (await ports.store.station(stations[0]!.id))!.value.state.status
    ).toBe("blocked")

    await clearTrain(ports.train, train.id)
    expect(
      (await ports.store.station(stations[0]!.id))!.value.state.status
    ).toBe("waiting")
    expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
    // The retry is a fresh run, forked again on the second signal.
    expect(ports.runs[1]!.runId).toBe(`${stations[0]!.id}-s2-r0`)
  })

  it("returns work with failed required checks without asking the Conductor", async () => {
    let reviews = 0
    const conductor: Conductor = {
      model: "spy",
      review: async (input) => {
        reviews += 1
        return new FakeConductor().review(input)
      },
    }
    let calls = 0
    const fake = new FakeStationRunner()
    const failsFirst: StationRunner = {
      config: fake.config,
      run: async (input) => {
        calls += 1
        const result = await fake.run(input)
        if (calls > 1 || !result.ok) return result
        return {
          ok: true,
          proposal: {
            ...result.proposal,
            evidence: {
              checks: [{ name: "test", required: true, status: "failed" }],
            },
          },
        }
      },
    }
    const ports = testPorts({ runner: failsFirst, conductor })
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id, {
      name: "Short",
      stations: [{ key: "a", name: "A", manifest: manifest() }],
    })

    await drive(ports, train.id)
    const returned = (await ports.store.eventsAfter(network.id, 0)).find(
      (envelope) => envelope.event.type === "station.returned"
    )
    expect(returned?.event).toMatchObject({
      feedback: { findings: ["test: failed"] },
    })
    expect(reviews).toBe(1)
  })

  it("blocks when the Conductor escalates", async () => {
    const conductor: Conductor = {
      model: "spy",
      review: async () => ({
        verdict: "escalate",
        summary: "Changes the public API without a manifest contract",
        findings: [],
      }),
    }
    const ports = testPorts({ conductor })
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)

    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(await trainState(ports, train.id)).toMatchObject({
      status: "blocked",
      issues: [{ kind: "review_escalated" }],
    })
  })

  it("reviews in its own step with the candidate's repository, then applies the durable verdict", async () => {
    const review = vi.fn<Conductor["review"]>(async (input) =>
      new FakeConductor().review(input)
    )
    const ports = testPorts({ conductor: { model: "spy", review } })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)

    let move = await advanceTrain(ports.train, train.id)
    while (move.kind !== "review") {
      if (move.kind === "await_station")
        await recordStationOutcome(
          ports.train,
          train.id,
          await runStation(ports, ports.runs.at(-1)!)
        )
      move = await advanceTrain(ports.train, train.id)
    }
    expect(move).toEqual({ kind: "review", stationId: stations[0]!.id })
    // Advancing never calls the Conductor; it waits for the review step.
    expect(await advanceTrain(ports.train, train.id)).toEqual(move)
    expect(review).not.toHaveBeenCalled()

    const station = (await ports.store.station(stations[0]!.id))!.value
    if (station.state.status !== "in_review") throw new Error("Not in review")
    await reviewStation(ports.train, train.id)
    await reviewStation(ports.train, train.id)
    expect(review).toHaveBeenCalledOnce()
    expect(review.mock.calls[0]![1]).toEqual({
      repoId: station.state.workspace.repoId,
      validation: (await ports.store.network(network.id))!.validation,
    })
    // A late failure report cannot discard a recorded verdict.
    await failReview(ports.train, train.id)
    expect(await advanceTrain(ports.train, train.id)).toEqual({
      kind: "moved",
    })
    expect((await ports.store.train(train.id))!.value.carIds).toHaveLength(1)
  })

  describe("evidence collected during review", () => {
    /** A Station run that leaves its evidence to the Conductor's checkout. */
    const unvalidated: StationRunner = {
      config: { harness: "fake", model: "fake" },
      run: async (input) => {
        const result = await new FakeStationRunner().run(input)
        return result.ok
          ? {
              ...result,
              proposal: { ...result.proposal, evidence: { checks: [] } },
            }
          : result
      },
    }
    const checks = (status: "passed" | "failed") => ({
      checks: [{ name: "test", required: true, status }],
    })

    it("attaches it to the accepted Car", async () => {
      const review = vi.fn<Conductor["review"]>(async () => ({
        verdict: "accept",
        summary: "Footer renders",
        findings: [],
        evidence: checks("passed"),
      }))
      const ports = testPorts({
        runner: unvalidated,
        conductor: { model: "spy", review },
      })
      const network = await seedNetwork(ports)
      const { train } = await seedLine(ports, network.id)

      expect(await drive(ports, train.id)).toEqual({ kind: "await_terminus" })
      // Empty evidence goes to review instead of being returned as missing.
      expect(review.mock.calls[0]![0].proposal.evidence).toEqual({
        checks: [],
      })
      const [car] = (await ports.store.snapshot(network.id))!.cars
      expect(car!.evidence).toEqual(checks("passed"))
    })

    it("keeps it with the rejected candidate when the review escalates", async () => {
      const ports = testPorts({
        runner: unvalidated,
        conductor: {
          model: "spy",
          review: async () => ({
            verdict: "escalate",
            summary: "Needs a contract decision",
            findings: [],
            evidence: checks("failed"),
          }),
        },
      })
      const network = await seedNetwork(ports)
      const { train, stations } = await seedLine(ports, network.id)

      expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
      const station = (await ports.store.station(stations[0]!.id))!.value
      expect(station.state.status).toBe("blocked")
      expect(station.lastReview?.proposal.evidence).toEqual(checks("failed"))
    })
  })

  it("blocks for intervention when the review step cannot produce a verdict", async () => {
    const ports = testPorts({
      conductor: {
        model: "spy",
        review: async () => {
          throw new Error("Conductor verdict failed validation")
        },
      },
    })
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)

    expect(await drive(ports, train.id)).toEqual({ kind: "await_clear" })
    expect(await trainState(ports, train.id)).toMatchObject({
      status: "blocked",
      issues: [
        {
          kind: "review_escalated",
          detail: expect.stringContaining(
            "review is required before acceptance"
          ),
        },
      ],
    })
    expect(
      (await ports.store.station(stations[0]!.id))!.value.state.status
    ).toBe("blocked")
  })

  it("ignores outcomes from runs that are no longer current", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train, stations } = await seedLine(ports, network.id)

    expect(await advanceTrain(ports.train, train.id)).toEqual({
      kind: "moved",
    })
    const move = await advanceTrain(ports.train, train.id)
    expect(move.kind).toBe("await_station")

    const outcome = await runStation(ports, ports.runs[0]!)
    await recordStationOutcome(ports.train, train.id, {
      ...outcome,
      runId: `${stations[0]!.id}-s9-r0`,
    })
    expect((await trainState(ports, train.id)).status).toBe("in_transit")

    await recordStationOutcome(ports.train, train.id, outcome)
    await recordStationOutcome(ports.train, train.id, outcome)
    expect((await trainState(ports, train.id)).status).toBe("approaching")
  })

  it("makes the same move when a step is repeated", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)

    await advanceTrain(ports.train, train.id)
    const first = await advanceTrain(ports.train, train.id)
    const repeated = await advanceTrain(ports.train, train.id)
    expect(repeated).toEqual(first)
    expect(ports.runs).toHaveLength(1)
  })
})
