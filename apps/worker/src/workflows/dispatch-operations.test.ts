import { describe, expect, it, vi } from "vitest"
import type { DispatchProposal } from "@terminus/domain"
import { DispatchProposalError } from "@terminus/agent-runtime"
import { NonRetryableError } from "cloudflare:workflows"
import {
  proposeDispatchPlan,
  launchPlannedLines,
  type DispatchPlanningPorts,
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
        stations: [{ key: "b", name: "B", manifest: work("src/b.ts") }],
      },
    ],
  }
}

async function fixture() {
  const base = testPorts()
  const network = await seedNetwork(base)
  const ports: DispatchPlanningPorts = {
    ...base.dispatcher,
    planner: { model: "fake", plan: vi.fn(async () => proposal()) },
    startPlanning: vi.fn(async () => {}),
    wakePlan: vi.fn(async () => {}),
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
    const readContext = vi.spyOn(f.ports.repositories, "readContext")
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
    expect(readContext).toHaveBeenCalledWith(
      f.network.terminusRepoId,
      f.network.terminusCommit
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
    f.ports.planner.plan = vi.fn(async () => p)
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
    vi.spyOn(f.ports.repositories, "readContext").mockResolvedValueOnce({
      commit: "wrong",
      paths: [],
      pathsTruncated: false,
      files: [],
    })
    await expect(prepareDispatchPlan(f.ports, f.plan.id)).rejects.toThrow(
      "different commit"
    )
    expect(f.ports.planner.plan).not.toHaveBeenCalled()
    f.ports.planner.plan = vi.fn(
      async () => ({ lines: [] }) as unknown as DispatchProposal
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
