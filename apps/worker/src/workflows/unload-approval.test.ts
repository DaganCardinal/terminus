import { describe, expect, it, vi } from "vitest"
import {
  drive,
  seedLine,
  seedNetwork,
  testPorts,
  twoStationLine,
} from "../../test/fixtures"
import {
  updateTrainUnload,
  selectPlanUnloadMode,
} from "../agents/unload-control"
import {
  requestTerminusClearance,
  placeHold,
  releaseHold,
} from "../agents/dispatcher"
import { advanceTrain } from "./train-operations"
import {
  prepareIntegration,
  promoteIntegration,
} from "./integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import { StaleWriteError } from "../integrations/network-store"
import { FakeDispatchPlanner } from "@terminus/agent-runtime"
import {
  proposeDispatchPlan,
  launchPlannedLines,
  type DispatchPlanningPorts,
} from "../agents/dispatch-planning"
import { prepareDispatchPlan, layDispatchLines } from "./dispatch-operations"

describe("durable human unloading gate", () => {
  it("lets a later automatic Train unload while the oldest waits, then validates the approved Train against current Terminus", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const manual = await seedLine(ports, network.id, {
      ...twoStationLine("Review Line"),
      unloadMode: "human_approval",
    })
    const auto = await seedLine(ports, network.id)
    await drive(ports, manual.train.id)
    await drive(ports, auto.train.id)
    // Even before its Workflow records held, the manual Train is ineligible.
    expect(
      await requestTerminusClearance(ports.dispatcher, manual.train.id)
    ).toBeNull()
    expect(await advanceTrain(ports.train, auto.train.id)).toEqual({
      kind: "moved",
    })
    const integration = {
      store: ports.store,
      repositories: ports.train.repositories,
      validator: new FakeIntegrationValidator(),
    }
    const first = (await ports.store.latestIntegration(auto.train.id))!
    await prepareIntegration(integration, first.input.id)
    await promoteIntegration(integration, first.input.id)
    await advanceTrain(ports.train, auto.train.id)
    const canonical = (await ports.store.network(network.id))!.terminusCommit

    await advanceTrain(ports.train, manual.train.id)
    expect(await advanceTrain(ports.train, manual.train.id)).toEqual({
      kind: "await_wake",
    })
    expect(
      (await ports.store.train(manual.train.id))!.value.state
    ).toMatchObject({
      status: "held",
      resume: { status: "returning" },
      reasons: [{ kind: "awaiting_user_approval" }],
    })
    expect(await ports.store.latestIntegration(manual.train.id)).toBeNull()
    const reviewed = (await ports.store.train(manual.train.id))!.value
    await expect(
      updateTrainUnload(ports.dispatcher, reviewed.id, { trainCommit: "stale" })
    ).rejects.toMatchObject({ status: 409 })
    // A lost wake is recovered from D1, with no browser or further command.
    ports.dispatcher.wakeTrain = vi.fn(async () => {
      throw new Error("Lost wake")
    })
    await updateTrainUnload(ports.dispatcher, reviewed.id, {
      trainCommit: reviewed.headCommit,
    })
    await updateTrainUnload(ports.dispatcher, reviewed.id, {
      trainCommit: reviewed.headCommit,
    })
    expect(
      (await ports.store.snapshot(network.id))!.unloadPolicies
    ).toContainEqual(
      expect.objectContaining({
        trainId: reviewed.id,
        approval: expect.objectContaining({ trainCommit: reviewed.headCommit }),
      })
    )
    await advanceTrain(ports.train, reviewed.id) // release
    await advanceTrain(ports.train, reviewed.id) // clearance
    const second = (await ports.store.latestIntegration(reviewed.id))!
    expect(second.input.terminusCommit).toBe(canonical)
    expect(second.input.trainCommit).toBe(reviewed.headCommit)
    await prepareIntegration(integration, second.input.id)
    await promoteIntegration(integration, second.input.id)
    await advanceTrain(ports.train, reviewed.id)
    expect((await ports.store.train(reviewed.id))!.value.state.status).toBe(
      "unloaded"
    )
    const events = await ports.store.eventsAfter(network.id, 0)
    expect(
      events.filter(({ event }) => event.type === "train.unload_approved")
    ).toHaveLength(1)
  })

  it("allows policy changes during work, holds only at the final gate, and keeps unrelated user holds after approval", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    await updateTrainUnload(ports.dispatcher, train.id, {
      mode: "human_approval",
    })
    await expect(
      updateTrainUnload(ports.dispatcher, train.id, {
        trainCommit: train.headCommit,
      })
    ).rejects.toMatchObject({ status: 409 })
    await drive(ports, train.id)
    const hold = await placeHold(ports.dispatcher, network.id, {
      kind: "user",
      scope: { kind: "train", trainId: train.id },
      note: "Hold",
    })
    await advanceTrain(ports.train, train.id)
    const head = (await ports.store.train(train.id))!.value.headCommit
    await updateTrainUnload(ports.dispatcher, train.id, { trainCommit: head })
    await advanceTrain(ports.train, train.id)
    expect((await ports.store.train(train.id))!.value.state).toMatchObject({
      status: "held",
      reasons: [{ kind: "user_hold" }],
    })
    expect(await ports.store.latestIntegration(train.id)).toBeNull()
    await updateTrainUnload(ports.dispatcher, train.id, { mode: "auto" })
    await updateTrainUnload(ports.dispatcher, train.id, {
      mode: "human_approval",
    })
    await releaseHold(ports.dispatcher, network.id, hold.id)
    await advanceTrain(ports.train, train.id)
    expect((await ports.store.train(train.id))!.value.state).toMatchObject({
      status: "held",
      reasons: [{ kind: "awaiting_user_approval" }],
    })
    await updateTrainUnload(ports.dispatcher, train.id, { mode: "auto" })
    await advanceTrain(ports.train, train.id)
    await advanceTrain(ports.train, train.id)
    expect(await ports.store.latestIntegration(train.id)).not.toBeNull()
  })

  it("atomically refuses stale approvals and policy changes after clearance, with no misleading events", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id, {
      ...twoStationLine(),
      unloadMode: "human_approval",
    })
    await drive(ports, train.id)
    const policy = (await ports.store.unloadPolicy(train.id))!
    const seq = await ports.store.lastSeq(network.id)
    await expect(
      ports.store.commit(
        network.id,
        [
          {
            kind: "unload_policy",
            policy: {
              ...policy.value,
              approval: {
                trainCommit: "stale",
                approvedAt: new Date().toISOString(),
              },
            },
            version: policy.version,
          },
        ],
        [
          {
            type: "train.unload_approved",
            trainId: train.id,
            trainCommit: "stale",
            approvedAt: new Date().toISOString(),
          },
        ]
      )
    ).rejects.toBeInstanceOf(StaleWriteError)
    expect(await ports.store.lastSeq(network.id)).toBe(seq)
    const head = (await ports.store.train(train.id))!.value.headCommit
    // Bypass the eligibility read to exercise the SQL clearance guard directly.
    expect(
      await ports.store.claimIntegration({
        id: "unapproved-clearance",
        networkId: network.id,
        trainId: train.id,
        trainRepoId: train.repoId,
        trainCommit: head,
        trainBaseline: train.terminusBaseline,
        terminusRepoId: network.terminusRepoId,
        terminusCommit: network.terminusCommit,
        acceptedCommits: [],
        validation: network.validation!,
      })
    ).toBeNull()
    expect(await ports.store.lastSeq(network.id)).toBe(seq)
    await updateTrainUnload(ports.dispatcher, train.id, { mode: "auto" })
    // Reservation freezes policy even before Train state becomes integrating.
    expect(
      await requestTerminusClearance(ports.dispatcher, train.id)
    ).not.toBeNull()
    await expect(
      updateTrainUnload(ports.dispatcher, train.id, { mode: "human_approval" })
    ).rejects.toMatchObject({ status: 409 })
    const latest = (await ports.store.unloadPolicy(train.id))!
    const before = await ports.store.lastSeq(network.id)
    await expect(
      ports.store.commit(
        network.id,
        [
          {
            kind: "unload_policy",
            policy: { ...latest.value, mode: "human_approval" },
            version: latest.version,
          },
        ],
        [
          {
            type: "train.unload_mode_changed",
            trainId: train.id,
            mode: "human_approval",
          },
        ]
      )
    ).rejects.toThrow("unload_policy_closed")
    expect(await ports.store.lastSeq(network.id)).toBe(before)
  })

  it("persists proposal overrides, carries recommendations to Trains, and refuses selections after launch", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const planning: DispatchPlanningPorts = {
      ...ports.dispatcher,
      planner: new FakeDispatchPlanner(),
      startPlanning: async () => {},
      wakePlan: async () => {},
      stopPlan: vi.fn(async () => {}),
      retryPlan: async () => {},
    }
    const plan = await proposeDispatchPlan(planning, network.id, {
      requestId: crypto.randomUUID(),
      goal: "Build",
    })
    await prepareDispatchPlan(planning, plan.id)
    await selectPlanUnloadMode(
      ports.dispatcher,
      network.id,
      plan.id,
      "goal",
      "human_approval"
    )
    expect((await ports.store.snapshot(network.id))!.trains).toHaveLength(0)
    await launchPlannedLines(planning, network.id, plan.id)
    await layDispatchLines(planning, plan.id)
    const snapshot = (await ports.store.snapshot(network.id))!
    expect(snapshot.unloadPolicies).toMatchObject([
      { mode: "human_approval", recommendation: { mode: "auto" } },
    ])
    await expect(
      selectPlanUnloadMode(
        ports.dispatcher,
        network.id,
        plan.id,
        "goal",
        "auto"
      )
    ).rejects.toMatchObject({ status: 409 })
  })
})
