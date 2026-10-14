import { describe, expect, it, vi } from "vitest"
import type { DispatchProposal } from "@terminus/domain"
import {
  DispatchProposalError,
  FakeDispatchPlanner,
} from "@terminus/agent-runtime"
import { NonRetryableError } from "cloudflare:workflows"
import {
  proposeDispatchPlan,
  stopDispatchPlan,
  retryDispatchPlan,
  launchPlannedLines,
  type DispatchPlanningPorts,
  selectPlanBaselineFix,
} from "../agents/dispatch-planning"
import {
  testPorts,
  seedNetwork,
  seedLine,
  drive,
  manifest,
} from "../../test/fixtures"
import {
  prepareDispatchPlan,
  layDispatchLines,
  startDispatchTrains,
  recordDispatchFailure,
} from "./dispatch-operations"
import { advanceTrain } from "./train-operations"
import {
  prepareIntegration,
  promoteIntegration,
} from "./integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"

function proposal(): DispatchProposal {
  const work = (path: string, dependencies: string[] = []) =>
    manifest({
      scope: ["Component"],
      expectedAreas: [path],
      invariants: ["Existing code works"],
      acceptanceCriteria: ["Accessible and tested"],
      expectedEvidence: ["test"],
      dependencies,
    })
  return {
    summary: "Two independent Lines",
    lines: [
      {
        key: "red",
        name: "Red Line",
        unloadRecommendation: {
          mode: "auto",
          reason: "Bounded component change.",
        },
        stations: [
          { key: "a", name: "A", manifest: work("src/a.ts") },
          {
            key: "a-tests",
            name: "A tests",
            manifest: work("src/a.test.ts", ["a"]),
          },
        ],
      },
      {
        key: "blue",
        name: "Blue Line",
        unloadRecommendation: {
          mode: "auto",
          reason: "Bounded component change.",
        },
        stations: [{ key: "b", name: "B", manifest: work("src/b.ts") }],
      },
    ],
  }
}

const planned = (proposal: DispatchProposal) => ({
  proposal,
  baseline: null,
})

async function fixture() {
  const base = testPorts()
  const network = await seedNetwork(base)
  const ports: DispatchPlanningPorts = {
    ...base.dispatcher,
    planner: { model: "fake", plan: vi.fn(async () => planned(proposal())) },
    startPlanning: vi.fn(async () => {}),
    wakePlan: vi.fn(async () => {}),
    stopPlan: vi.fn(async () => {}),
    retryPlan: vi.fn(async () => {}),
  }
  const request = {
    requestId: crypto.randomUUID(),
    goal: "Build two independent features",
  }
  const plan = await proposeDispatchPlan(ports, network.id, request)
  return { base, ports, network, request, plan }
}

async function promoteOtherWork(f: Awaited<ReturnType<typeof fixture>>) {
  const line = await seedLine(f.base, f.network.id)
  await drive(f.base, line.train.id)
  await advanceTrain(f.base.train, line.train.id)
  const attempt = (await f.ports.store.latestIntegration(line.train.id))!
  const integration = {
    store: f.ports.store,
    repositories: f.ports.repositories,
    validator: new FakeIntegrationValidator(),
  }
  await prepareIntegration(integration, attempt.input.id)
  await promoteIntegration(integration, attempt.input.id)
}

describe("durable Dispatcher planning and launch", () => {
  it("stops durable model retries after corrective validation is exhausted and persists safe field diagnostics", async () => {
    const f = await fixture()
    f.ports.planner.plan = vi.fn(async () => {
      throw new DispatchProposalError([
        {
          path: "lines.0.stations.0.manifest.avoidAreas.6",
          code: "invalid_format",
        },
      ])
    })
    await expect(
      prepareDispatchPlan(f.ports, f.plan.id)
    ).rejects.toBeInstanceOf(NonRetryableError)
    const saved = (await f.ports.store.dispatchPlan(f.plan.id))!.value
    expect(saved.state).toMatchObject({
      status: "failed",
      message: expect.stringContaining("avoidAreas.6 (invalid_format)"),
    })
    await prepareDispatchPlan(f.ports, f.plan.id)
    expect(f.ports.planner.plan).toHaveBeenCalledOnce()
    const snapshot = (await f.ports.store.snapshot(f.network.id))!
    expect(snapshot.trains).toEqual([])
    expect(snapshot.lines).toEqual([])
  })
  it("runs a two-Line proposal through sequential Stations, review, Cars and canonical integration", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await launchPlannedLines(f.ports, f.network.id, f.plan.id)
    await layDispatchLines(f.ports, f.plan.id)
    await startDispatchTrains(f.ports, f.plan.id)
    const planned = (await f.ports.store.dispatchPlan(f.plan.id))!.value
    if (planned.state.status !== "launched")
      throw new Error("Plan did not launch")
    await Promise.all(planned.state.trainIds.map((id) => drive(f.base, id)))
    const integration = {
      store: f.ports.store,
      repositories: f.ports.repositories,
      validator: new FakeIntegrationValidator(),
    }
    // Dispatcher clearance controls integration order even though Station work is concurrent.
    const returning = await f.ports.store.returningTrains(f.network.id)
    for (const { value: train } of returning) {
      await advanceTrain(f.base.train, train.id)
      const attempt = (await f.ports.store.latestIntegration(train.id))!
      await prepareIntegration(integration, attempt.input.id)
      await promoteIntegration(integration, attempt.input.id)
      await advanceTrain(f.base.train, train.id)
    }
    const final = (await f.ports.store.snapshot(f.network.id))!
    expect(
      final.trains.every(({ train }) => train.state.status === "unloaded")
    ).toBe(true)
    expect(final.cars).toHaveLength(3)
    expect(
      final.stations.every((station) => station.state.status === "complete")
    ).toBe(true)
    const attempts = await f.ports.store.integrations(f.network.id)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.input.terminusCommit).toBe(
      attempts[0]!.candidate!.headCommit
    )
    expect(final.network.terminusCommit).toBe(
      attempts[1]!.candidate!.headCommit
    )
  })
  it("checkpoints proposals without starting work and reuses them after lost acknowledgements", async () => {
    const f = await fixture()
    const commit = f.ports.store.commit.bind(f.ports.store)
    vi.spyOn(f.ports.store, "commit").mockImplementationOnce(
      async (...args) => {
        await commit(...args)
        throw new Error("Lost acknowledgement")
      }
    )
    await expect(prepareDispatchPlan(f.ports, f.plan.id)).rejects.toThrow(
      "Lost acknowledgement"
    )
    await prepareDispatchPlan(f.ports, f.plan.id)
    expect(f.ports.planner.plan).toHaveBeenCalledOnce()
    expect(f.ports.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: {
          repoId: f.network.terminusRepoId,
          commit: f.network.terminusCommit,
        },
        checkBaseline: false,
        validation: expect.arrayContaining([
          expect.objectContaining({ name: "test" }),
        ]),
      })
    )
    expect((await f.ports.store.snapshot(f.network.id))!.trains).toEqual([])
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))!.value.state.status
    ).toBe("ready")
  })
  it("deduplicates simultaneous submissions and refuses reuse for different goals or networks", async () => {
    const f = await fixture()
    await Promise.all([
      proposeDispatchPlan(f.ports, f.network.id, f.request),
      proposeDispatchPlan(f.ports, f.network.id, f.request),
    ])
    expect((await f.ports.store.snapshot(f.network.id))!.plans).toHaveLength(1)
    expect(
      (await f.ports.store.eventsAfter(f.network.id, 0)).filter(
        (e) => e.event.type === "dispatcher.plan_requested"
      )
    ).toHaveLength(1)
    await expect(
      proposeDispatchPlan(f.ports, f.network.id, {
        ...f.request,
        goal: "Different",
      })
    ).rejects.toThrow("different goal")
    const other = await seedNetwork(f.base)
    await expect(
      proposeDispatchPlan(f.ports, other.id, f.request)
    ).rejects.toThrow("different goal or network")
    await expect(
      launchPlannedLines(f.ports, other.id, f.plan.id)
    ).rejects.toThrow("Unknown plan")
  })
  it("persists invalid dependency/evidence assessment but never lays its Lines", async () => {
    const f = await fixture()
    const p = proposal()
    p.lines[1]!.stations[0]!.manifest.dependencies = ["a"]
    p.lines[0]!.stations[0]!.manifest.expectedEvidence = ["invented"]
    f.ports.planner.plan = vi.fn(async () => planned(p))
    await expect(
      launchPlannedLines(f.ports, f.network.id, f.plan.id)
    ).rejects.toThrow("not ready")
    await prepareDispatchPlan(f.ports, f.plan.id)
    await expect(
      launchPlannedLines(f.ports, f.network.id, f.plan.id)
    ).rejects.toThrow("configured project check")
    expect((await f.ports.store.snapshot(f.network.id))!.lines).toEqual([])
  })
  it("lays all Lines atomically, resolves same-Line keys, and retries kickoff without duplicate topology", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await Promise.all([
      launchPlannedLines(f.ports, f.network.id, f.plan.id),
      launchPlannedLines(f.ports, f.network.id, f.plan.id),
    ])
    const fork = vi.spyOn(f.ports.repositories, "fork")
    const started = new Set<string>()
    f.ports.startTrain = vi.fn(async (id) => {
      started.add(id)
    })
    await layDispatchLines(f.ports, f.plan.id)
    await layDispatchLines(f.ports, f.plan.id)
    expect(fork).toHaveBeenCalledTimes(2)
    expect(f.ports.startTrain).not.toHaveBeenCalled()
    let snapshot = (await f.ports.store.snapshot(f.network.id))!
    expect(snapshot.lines).toHaveLength(2)
    expect(snapshot.stations).toHaveLength(3)
    expect(snapshot.trains).toHaveLength(2)
    const red = snapshot.lines.find((line) => line.name === "Red Line")!
    expect(
      snapshot.stations.find((station) => station.name === "A tests")!.manifest
        .dependencies
    ).toEqual([red.stationIds[0]])
    f.ports.startTrain = vi.fn(async (id) => {
      started.add(id)
      if (started.size === 1) throw new Error("Lost kickoff response")
    })
    await expect(startDispatchTrains(f.ports, f.plan.id)).rejects.toThrow(
      "Lost kickoff"
    )
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))!.value.state.status
    ).toBe("starting")
    await startDispatchTrains(f.ports, f.plan.id)
    await startDispatchTrains(f.ports, f.plan.id)
    expect(started.size).toBe(2)
    snapshot = (await f.ports.store.snapshot(f.network.id))!
    expect(snapshot.plans[0]!.state.status).toBe("launched")
    expect(snapshot.lines).toHaveLength(2)
    const events = await f.ports.store.eventsAfter(f.network.id, 0)
    expect(
      events.filter((e) => e.event.type === "dispatcher.launch_requested")
    ).toHaveLength(1)
    expect(
      events.filter((e) => e.event.type === "dispatcher.plan_launched")
    ).toHaveLength(1)
  })
  it("keeps topology absent after a failed fork and reuses stable fork identities", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await launchPlannedLines(f.ports, f.network.id, f.plan.id)
    const original = f.ports.repositories.fork.bind(f.ports.repositories)
    const fork = vi
      .spyOn(f.ports.repositories, "fork")
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error("Unavailable"))
    await expect(layDispatchLines(f.ports, f.plan.id)).rejects.toThrow(
      "Unavailable"
    )
    expect((await f.ports.store.snapshot(f.network.id))!.lines).toEqual([])
    await layDispatchLines(f.ports, f.plan.id)
    expect(fork.mock.calls[0]![0]).toEqual(fork.mock.calls[2]![0])
    expect((await f.ports.store.snapshot(f.network.id))!.trains).toHaveLength(2)
  })
  it("rejects a canonical change after review", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await promoteOtherWork(f)
    await expect(
      launchPlannedLines(f.ports, f.network.id, f.plan.id)
    ).rejects.toThrow("Terminus changed")
    expect(
      (await f.ports.store.snapshot(f.network.id))!.plans[0]!.state.status
    ).toBe("ready")
  })
  it("rolls back topology and events if canonical state advances while repositories are being forked", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await launchPlannedLines(f.ports, f.network.id, f.plan.id)
    const original = f.ports.repositories.fork.bind(f.ports.repositories)
    vi.spyOn(f.ports.repositories, "fork").mockImplementationOnce(
      async (input) => {
        const result = await original(input)
        await promoteOtherWork(f)
        return result
      }
    )
    await expect(layDispatchLines(f.ports, f.plan.id)).rejects.toThrow(
      "stale_plan"
    )
    const snapshot = (await f.ports.store.snapshot(f.network.id))!
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.plans[0]!.state.status).toBe("launching")
    expect(
      (await f.ports.store.eventsAfter(f.network.id, 0)).some(
        (e) => e.event.type === "dispatcher.lines_laid"
      )
    ).toBe(false)
  })
  it("rejects mismatched or malformed context/output, and stores safe failure diagnostics", async () => {
    const f = await fixture()
    f.ports.planner.plan = vi.fn(async () => ({
      ...planned(proposal()),
      baseline: { commit: "wrong", checks: [] },
    }))
    await expect(prepareDispatchPlan(f.ports, f.plan.id)).rejects.toThrow(
      "different commit"
    )
    f.ports.planner.plan = vi.fn(async () =>
      planned({ lines: [] } as unknown as DispatchProposal)
    )
    await expect(prepareDispatchPlan(f.ports, f.plan.id)).rejects.toThrow()
    await recordDispatchFailure(f.ports, f.plan.id, "planning")
    await recordDispatchFailure(f.ports, f.plan.id, "planning")
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))!.value.state
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("valid proposal"),
    })
    expect(
      (await f.ports.store.eventsAfter(f.network.id, 0)).filter(
        (e) => e.event.type === "dispatcher.plan_failed"
      )
    ).toHaveLength(1)
  })
})

it("launches planned Crossing references atomically across Lines", async () => {
  const f = await fixture(),
    p = proposal()
  p.lines[1]!.route = [
    { kind: "crossing", source: { kind: "planned", stationKey: "a-tests" } },
    { kind: "station", key: "b" },
  ]
  f.ports.planner.plan = vi.fn(async () => planned(p))
  await prepareDispatchPlan(f.ports, f.plan.id)
  await launchPlannedLines(f.ports, f.network.id, f.plan.id)
  await layDispatchLines(f.ports, f.plan.id)
  const snapshot = (await f.ports.store.snapshot(f.network.id))!
  expect(snapshot.crossings).toHaveLength(1)
  const c = snapshot.crossings![0]!,
    source = snapshot.stations.find((s) => s.id === c.sourceStationId)!
  expect(source.name).toBe("A tests")
  expect(source.lineId).not.toBe(c.lineId)
  expect(
    snapshot.lines.find((l) => l.id === c.lineId)?.stops?.[0]
  ).toMatchObject({ kind: "crossing", stationId: source.id })
})

it("atomically launches Junction proposals with stable membership and a deferred outgoing Train", async () => {
  const f = await fixture(),
    p = proposal(),
    a = p.lines[0]!,
    b = p.lines[1]!
  f.ports.planner.plan = async () =>
    planned({
      summary: "Feature",
      lines: [],
      junctions: [
        {
          key: "feature",
          name: "Feature",
          brief: {
            goal: "Feature",
            scope: ["src/"],
            contracts: [],
            invariants: [],
            acceptanceCriteria: ["works"],
            validation: [{ name: "test", command: ["npm", "test"] }],
          },
          incoming: [
            { name: a.name, stations: a.stations },
            { name: b.name, stations: b.stations },
          ],
          outgoing: { name: "Deliver", stations: [] },
        },
      ],
    })
  f.ports.startJunction = vi.fn(async () => {})
  await prepareDispatchPlan(f.ports, f.plan.id)
  await launchPlannedLines(f.ports, f.network.id, f.plan.id)
  await layDispatchLines(f.ports, f.plan.id)
  const snapshot = (await f.base.store.snapshot(f.network.id))!
  expect(snapshot.junctions).toHaveLength(1)
  expect(snapshot.lines).toHaveLength(3)
  expect(snapshot.trains).toHaveLength(2)
  const j = snapshot.junctions![0]!
  expect(await f.base.store.train(j.outgoingTrainId)).toBeNull()
  const forks = vi.spyOn(f.ports.repositories, "fork")
  await layDispatchLines(f.ports, f.plan.id)
  expect(forks).not.toHaveBeenCalled()
  await startDispatchTrains(f.ports, f.plan.id)
  expect(f.ports.startJunction).toHaveBeenCalledWith(j.id)
  expect((await f.base.store.dispatchPlan(f.plan.id))!.value.state.status).toBe(
    "launched"
  )
})

describe("baseline checks before planning", () => {
  it("records the baseline option, refuses reusing a request with a different option, and persists the report", async () => {
    const f = await fixture()
    await expect(
      proposeDispatchPlan(f.ports, f.network.id, {
        ...f.request,
        checkBaseline: true,
      })
    ).rejects.toThrow("different goal")
    const request = { ...f.request, requestId: crypto.randomUUID() }
    const checked = await proposeDispatchPlan(f.ports, f.network.id, {
      ...request,
      checkBaseline: true,
    })
    expect(checked.checkBaseline).toBe(true)
    f.ports.planner = new FakeDispatchPlanner()
    await prepareDispatchPlan(f.ports, checked.id)
    const plan = (await f.ports.store.dispatchPlan(checked.id))!.value
    if (plan.state.status !== "ready") throw new Error("Expected ready")
    expect(plan.state.baseline?.checks.some((c) => c.status === "failed")).toBe(
      true
    )
    expect(plan.state.proposal.findings?.length).toBeGreaterThan(0)
    expect(plan.state.proposal.baselineFix).toBeDefined()
    expect(plan.state.assessment.errors).toEqual([])
  })

  it("lays an included fix with Crossings on every other Line, and omits a rejected fix", async () => {
    for (const selection of ["include", "reject"] as const) {
      const f = await fixture()
      f.ports.planner = new FakeDispatchPlanner()
      const plan = await proposeDispatchPlan(f.ports, f.network.id, {
        requestId: crypto.randomUUID(),
        goal: "Add a footer",
        checkBaseline: true,
      })
      await prepareDispatchPlan(f.ports, plan.id)
      if (selection === "reject")
        await selectPlanBaselineFix(f.ports, f.network.id, plan.id, "reject")
      await launchPlannedLines(f.ports, f.network.id, plan.id)
      await layDispatchLines(f.ports, plan.id)
      const snapshot = (await f.ports.store.snapshot(f.network.id))!
      const fix = snapshot.lines.find((l) => l.name === "Baseline Fix Line")
      if (selection === "reject") {
        expect(fix).toBeUndefined()
        expect(snapshot.crossings ?? []).toEqual([])
        continue
      }
      expect(fix).toBeDefined()
      const goal = snapshot.lines.find((l) => l.name === "Goal Line")!
      expect(goal.stops?.[0]).toMatchObject({
        kind: "crossing",
        stationId: fix!.stationIds[0],
      })
      expect(snapshot.trains).toHaveLength(2)
    }
  })

  it("refuses baseline fix selection without a fix", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    await expect(
      selectPlanBaselineFix(f.ports, f.network.id, f.plan.id, "reject")
    ).rejects.toThrow("no baseline fix")
  })
})

describe("Dispatcher cancellation", () => {
  it("persists cancellation and one event, repeats cleanup, and refuses retry or launch", async () => {
    const f = await fixture()
    const cleanup = vi.fn(async () => {
      expect(
        (await f.ports.store.dispatchPlan(f.plan.id))?.value.state
      ).toMatchObject({ reason: "cancelled" })
    })
    f.ports.stopPlan = cleanup
    await stopDispatchPlan(f.ports, f.network.id, f.plan.id)
    await stopDispatchPlan(f.ports, f.network.id, f.plan.id)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await prepareDispatchPlan(f.ports, f.plan.id)
    expect(f.ports.planner.plan).not.toHaveBeenCalled()
    await expect(
      retryDispatchPlan(f.ports, f.network.id, f.plan.id)
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      launchPlannedLines(f.ports, f.network.id, f.plan.id)
    ).rejects.toMatchObject({ status: 409 })
    const snapshot = (await f.ports.store.snapshot(f.network.id))!
    expect(snapshot.lines).toHaveLength(0)
    const events = await f.ports.store.eventsAfter(f.network.id, 0)
    expect(
      events.filter((entry) => entry.event.type === "dispatcher.plan_cancelled")
    ).toHaveLength(1)
  })

  it("discards a late model result and failure after Stop", async () => {
    const f = await fixture()
    f.ports.planner.plan = vi.fn(async () => {
      await stopDispatchPlan(f.ports, f.network.id, f.plan.id)
      return planned(proposal())
    })
    await prepareDispatchPlan(f.ports, f.plan.id)
    await recordDispatchFailure(f.ports, f.plan.id, "planning")
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))?.value.state
    ).toMatchObject({ reason: "cancelled" })
  })

  it("keeps the durable stop when cleanup fails and allows cleanup to be retried", async () => {
    const f = await fixture()
    f.ports.stopPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined)
    await expect(
      stopDispatchPlan(f.ports, f.network.id, f.plan.id)
    ).rejects.toThrow("cleanup failed")
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))?.value.state
    ).toMatchObject({ cleanupPending: true })
    await stopDispatchPlan(f.ports, f.network.id, f.plan.id)
    expect(f.ports.stopPlan).toHaveBeenCalledTimes(2)
  })

  it("refuses stopping another network's plan or a finished proposal", async () => {
    const f = await fixture()
    await expect(
      stopDispatchPlan(f.ports, "other", f.plan.id)
    ).rejects.toMatchObject({ status: 404 })
    await prepareDispatchPlan(f.ports, f.plan.id)
    await expect(
      stopDispatchPlan(f.ports, f.network.id, f.plan.id)
    ).rejects.toMatchObject({ status: 409 })
    expect(f.ports.stopPlan).not.toHaveBeenCalled()
  })
})
