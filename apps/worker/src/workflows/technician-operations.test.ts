import { describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:test"
import { repairModels } from "../agents/ports"
import {
  FakeTechnicianRunner,
  FakeRepairConductor,
} from "@terminus/agent-runtime"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import {
  dispatchTechnician,
  approveTechnician,
  type TechnicianPorts,
} from "../agents/technician"
import { resolveConflict, placeHold, releaseHold } from "../agents/dispatcher"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { advanceTrain } from "./train-operations"
import {
  prepareIntegration,
  promoteIntegration,
  failIntegration,
} from "./integration-operations"
import {
  prepareTechnician,
  runTechnician,
  validateTechnician,
  reviewTechnician,
} from "./technician-operations"

async function fixture() {
  const ports = testPorts()
  const network = await seedNetwork(ports)
  const { train } = await seedLine(ports, network.id)
  await drive(ports, train.id)
  await advanceTrain(ports.train, train.id)
  const integration = {
    store: ports.store,
    repositories: ports.train.repositories,
    validator: new FakeIntegrationValidator(),
  }
  const attempt = (await ports.store.latestIntegration(train.id))!
  vi.spyOn(ports.train.repositories, "prepareIntegration").mockResolvedValue({
    ok: false,
    conflictPaths: ["src/shared.ts"],
  })
  await prepareIntegration(integration, attempt.input.id)
  await advanceTrain(ports.train, train.id)
  const conflict = (await ports.store.conflicts(network.id))[0]!
  const technician: TechnicianPorts = {
    ...ports.dispatcher,
    runner: new FakeTechnicianRunner(),
    reviewer: new FakeRepairConductor(),
    validator: new FakeIntegrationValidator(),
    startRepair: vi.fn(async () => {}),
  }
  async function ready() {
    const repair = await dispatchTechnician(technician, network.id, conflict.id)
    await prepareTechnician(technician, repair.id)
    await runTechnician(technician, repair.id)
    await validateTechnician(technician, repair.id)
    await reviewTechnician(technician, repair.id)
    return (await ports.store.repair(repair.id))!.value
  }
  return { ports, network, train, integration, conflict, technician, ready }
}

describe("Technician reconciliation orchestration", () => {
  it("keeps Technician and repair Conductor settings through validation, review and retries", async () => {
    const f = await fixture()
    await f.ports.store.setNetworkModelSettings(
      f.network.id,
      { preset: "medium" },
      f.ports.dispatcher.now()
    )
    const repair = await dispatchTechnician(
      f.technician,
      f.network.id,
      f.conflict.id
    )
    const original = await repairModels(env, repair.id)
    await f.ports.store.setNetworkModelSettings(
      f.network.id,
      { preset: "light" },
      f.ports.dispatcher.now()
    )
    await f.ready()
    expect(await repairModels(env, repair.id)).toEqual(original)
    expect(original.executions!.conductor.model).toBe("@cf/zai-org/glm-5.3")
    expect(original.executions!.technician.model).toBe("@cf/zai-org/glm-5.3")
  })
  it("repairs a blocked integration, explicitly approves, promotes, resolves, and unloads without changing Cars", async () => {
    const f = await fixture()
    const before = (await f.ports.store.train(f.train.id))!.value
    const repair = await f.ready()
    expect(repair.state.status).toBe("ready")
    expect((await f.ports.store.train(f.train.id))!.value).toEqual(before)
    expect((await f.ports.store.conflicts(f.network.id))[0]!.status).toBe(
      "open"
    )
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "await_clear",
    })
    await expect(
      resolveConflict(f.ports.dispatcher, f.network.id, f.conflict.id)
    ).rejects.toThrow("only after promotion")
    await approveTechnician(f.technician, f.network.id, repair.id)
    // The persisted approval also recovers a lost Workflow clear event.
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "moved",
    })
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "moved",
    })
    const attempt = (await f.ports.store.latestIntegration(f.train.id))!
    expect(attempt.input.repairId).toBe(repair.id)
    await prepareIntegration(f.integration, attempt.input.id)
    expect((await f.ports.store.conflicts(f.network.id))[0]!.status).toBe(
      "open"
    )
    expect((await promoteIntegration(f.integration, attempt.input.id)).ok).toBe(
      true
    )
    await advanceTrain(f.ports.train, f.train.id)
    expect((await f.ports.store.train(f.train.id))!.value).toMatchObject({
      state: { status: "unloaded" },
      carIds: before.carIds,
      headCommit: before.headCommit,
    })
    expect((await f.ports.store.repair(repair.id))!.value.state.status).toBe(
      "integrated"
    )
    expect((await f.ports.store.conflicts(f.network.id))[0]!.status).toBe(
      "resolved"
    )
    const events = (await f.ports.store.eventsAfter(f.network.id, 0)).map(
      (row) => row.event.type
    )
    expect(events.indexOf("conflict.resolved")).toBeGreaterThan(
      events.indexOf("terminus.promoted")
    )
    expect(events).toContain("technician.integrated")
  })
  it("is idempotent at dispatch, workspace, execution, review, and approval", async () => {
    const f = await fixture()
    const run = vi.spyOn(f.technician.runner, "run")
    const review = vi.spyOn(f.technician.reviewer, "review")
    const repair = await f.ready()
    expect(
      (await dispatchTechnician(f.technician, f.network.id, f.conflict.id)).id
    ).toBe(repair.id)
    await prepareTechnician(f.technician, repair.id)
    await runTechnician(f.technician, repair.id)
    await reviewTechnician(f.technician, repair.id)
    await approveTechnician(f.technician, f.network.id, repair.id)
    await approveTechnician(f.technician, f.network.id, repair.id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(review).toHaveBeenCalledTimes(1)
    // The Conductor verifies the repair's own candidate repository.
    const reviewed = (await f.ports.store.repair(repair.id))!.value
    expect(review.mock.calls[0]![1]).toMatchObject({
      repoId:
        "workspaceRepoId" in reviewed.state
          ? reviewed.state.workspaceRepoId
          : undefined,
      validation: expect.any(Array),
    })
    expect(
      (await f.ports.store.eventsAfter(f.network.id, 0)).filter(
        (row) => row.event.type === "technician.approved"
      )
    ).toHaveLength(1)
  })
  it("retains rejected work and feedback when independent checks fail", async () => {
    const f = await fixture()
    const reviewer = vi.spyOn(f.technician.reviewer, "review")
    vi.spyOn(f.technician.validator, "validate").mockResolvedValue({
      checks: [{ name: "test", required: true, status: "failed" }],
    })
    const repair = await f.ready()
    expect(repair.state).toMatchObject({
      status: "rejected",
      proposal: { evidence: { checks: [{ status: "failed" }] } },
      review: { verdict: "return" },
    })
    expect(reviewer).not.toHaveBeenCalled()
    await expect(
      approveTechnician(f.technician, f.network.id, repair.id)
    ).rejects.toThrow("reviewed repair")
    expect((await f.ports.store.train(f.train.id))!.value.state.status).toBe(
      "blocked"
    )
  })
  it("rejects stale approval and cross-network commands", async () => {
    const f = await fixture()
    const repair = await f.ready()
    await expect(
      approveTechnician(f.technician, "other-network", repair.id)
    ).rejects.toThrow("Unknown repair")
    // Simulate the Train changing after review without rewriting its Cars.
    const train = (await f.ports.store.train(f.train.id))!
    await f.ports.store.commit(
      f.network.id,
      [
        {
          kind: "train",
          train: { ...train.value, headCommit: "moved" },
          version: train.version,
        },
      ],
      []
    )
    await expect(
      approveTechnician(f.technician, f.network.id, repair.id)
    ).rejects.toThrow("stale")
    expect((await f.ports.store.repair(repair.id))!.value.state.status).toBe(
      "ready"
    )
  })
  it("preserves user holds and does not clear unrelated conflicts in an approval loop", async () => {
    const f = await fixture()
    const repair = await f.ready()
    await approveTechnician(f.technician, f.network.id, repair.id)
    const other = {
      ...f.conflict,
      id: "unrelated",
      description: "Another conflict",
    }
    await f.ports.store.commit(
      f.network.id,
      [{ kind: "conflict", conflict: other }],
      []
    )
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "await_clear",
    })
    await resolveConflict(f.ports.dispatcher, f.network.id, other.id)
    const hold = await placeHold(f.ports.dispatcher, f.network.id, {
      kind: "user",
      scope: { kind: "train", trainId: f.train.id },
      note: "Wait",
    })
    await advanceTrain(f.ports.train, f.train.id)
    await advanceTrain(f.ports.train, f.train.id)
    expect((await f.ports.store.train(f.train.id))!.value.state.status).toBe(
      "held"
    )
    await releaseHold(f.ports.dispatcher, f.network.id, hold.id)
    await advanceTrain(f.ports.train, f.train.id)
    await advanceTrain(f.ports.train, f.train.id)
    const attempt = (await f.ports.store.latestIntegration(f.train.id))!
    await prepareIntegration(f.integration, attempt.input.id)
    expect((await promoteIntegration(f.integration, attempt.input.id)).ok).toBe(
      true
    )
  })
  it("reuses the repair's independent evidence instead of validating its exact candidate again", async () => {
    const f = await fixture()
    const repair = await f.ready()
    await approveTechnician(f.technician, f.network.id, repair.id)
    await advanceTrain(f.ports.train, f.train.id)
    await advanceTrain(f.ports.train, f.train.id)
    const attempt = (await f.ports.store.latestIntegration(f.train.id))!
    const validate = vi.spyOn(f.integration.validator, "validate")
    await prepareIntegration(f.integration, attempt.input.id)
    expect(validate).not.toHaveBeenCalled()
    const approved = (await f.ports.store.repair(repair.id))!.value.state
    if (approved.status !== "approved") throw new Error("Expected approval")
    const prepared = (await f.ports.store.integration(attempt.input.id))!
    expect(prepared.status).toBe("prepared")
    expect(prepared.evidence).toEqual(approved.proposal.evidence)
    expect((await promoteIntegration(f.integration, attempt.input.id)).ok).toBe(
      true
    )
  })
  it("retains a rejected candidate on final validation failure and requires fresh intervention", async () => {
    const f = await fixture()
    // Evidence recorded under other commands no longer proves this
    // attempt's checks, so integration validates the candidate itself.
    const validate = f.technician.validator.validate.bind(
      f.technician.validator
    )
    vi.spyOn(f.technician.validator, "validate").mockImplementation(
      async (candidate, commands) => {
        const evidence = await validate(candidate, commands)
        return {
          checks: evidence.checks.map((check) => ({
            ...check,
            command: [...(check.command ?? []), "--previous-config"],
          })),
        }
      }
    )
    const repair = await f.ready()
    await approveTechnician(f.technician, f.network.id, repair.id)
    await advanceTrain(f.ports.train, f.train.id)
    await advanceTrain(f.ports.train, f.train.id)
    const attempt = (await f.ports.store.latestIntegration(f.train.id))!
    vi.spyOn(f.integration.validator, "validate").mockResolvedValue({
      checks: [{ name: "test", required: true, status: "failed" }],
    })
    await prepareIntegration(f.integration, attempt.input.id)
    expect(f.integration.validator.validate).toHaveBeenCalledOnce()
    await advanceTrain(f.ports.train, f.train.id)
    expect((await f.ports.store.repair(repair.id))!.value.state.status).toBe(
      "rejected"
    )
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "await_clear",
    })
    expect((await f.ports.store.conflicts(f.network.id))[0]!.status).toBe(
      "open"
    )
    vi.mocked(f.technician.validator.validate).mockRestore()
    const fresh = await f.ready()
    expect(fresh.id).not.toBe(repair.id)
    expect(fresh.state.status).toBe("ready")
  })
  it("rejects stale Terminus candidates and prepares a fresh repair against its new head", async () => {
    const f = await fixture()
    const repair = await f.ready()
    const other = await seedLine(f.ports, f.network.id)
    await drive(f.ports, other.train.id)
    await advanceTrain(f.ports.train, other.train.id)
    const attempt = (await f.ports.store.latestIntegration(other.train.id))!
    vi.mocked(f.ports.train.repositories.prepareIntegration).mockResolvedValue({
      ok: true,
      candidate: { repoId: "other-integration", headCommit: "new-terminus" },
    })
    await prepareIntegration(f.integration, attempt.input.id)
    await promoteIntegration(f.integration, attempt.input.id)
    await advanceTrain(f.ports.train, other.train.id)
    await expect(
      approveTechnician(f.technician, f.network.id, repair.id)
    ).rejects.toThrow("stale")
    const fresh = await f.ready()
    expect(fresh.source.terminusCommit).toBe("new-terminus")
    expect((await f.ports.store.repair(repair.id))!.value.state.status).toBe(
      "stale"
    )
    expect(fresh.state.status).toBe("ready")
  })
  it("converges concurrent dispatch and approval commands on a single repair", async () => {
    const f = await fixture()
    const dispatched = await Promise.all([
      dispatchTechnician(f.technician, f.network.id, f.conflict.id),
      dispatchTechnician(f.technician, f.network.id, f.conflict.id),
    ])
    expect(dispatched[0]!.id).toBe(dispatched[1]!.id)
    const repair = await f.ready()
    const approvals = await Promise.all([
      approveTechnician(f.technician, f.network.id, repair.id),
      approveTechnician(f.technician, f.network.id, repair.id),
    ])
    expect(approvals.every((item) => item.state.status === "approved")).toBe(
      true
    )
    expect(await f.ports.store.repairs(f.network.id)).toHaveLength(1)
  })
  it("rejects a repair whose repositories moved before promotion", async () => {
    const f = await fixture()
    const repair = await f.ready()
    await approveTechnician(f.technician, f.network.id, repair.id)
    await advanceTrain(f.ports.train, f.train.id)
    await advanceTrain(f.ports.train, f.train.id)
    const attempt = (await f.ports.store.latestIntegration(f.train.id))!
    vi.spyOn(f.ports.train.repositories, "confirmRepair").mockRejectedValue(
      new Error("Repair repository no longer contains the reviewed candidate")
    )
    await expect(
      prepareIntegration(f.integration, attempt.input.id)
    ).rejects.toThrow("reviewed candidate")
    await failIntegration(f.integration, attempt.input.id, "Candidate changed")
    expect((await f.ports.store.network(f.network.id))!.terminusCommit).toBe(
      f.network.terminusCommit
    )
  })
})
