import { describe, expect, it, vi } from "vitest"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import {
  drive,
  seedLine,
  seedNetwork,
  testPorts,
  type TestPorts,
} from "../../test/fixtures"
import { placeHold, releaseHold, resolveConflict } from "../agents/dispatcher"
import {
  advanceTrain,
  clearTrain,
  recordIntegrationOutcome,
} from "./train-operations"
import {
  failIntegration,
  prepareIntegration,
  promoteIntegration,
  type IntegrationPorts,
} from "./integration-operations"

function integrationPorts(ports: TestPorts): IntegrationPorts {
  return {
    store: ports.store,
    repositories: ports.train.repositories,
    validator: new FakeIntegrationValidator(),
  }
}

async function returning(ports: TestPorts, networkId: string) {
  const { train } = await seedLine(ports, networkId)
  await drive(ports, train.id)
  return train
}

async function clear(ports: TestPorts, trainId: string) {
  expect(await advanceTrain(ports.train, trainId)).toEqual({ kind: "moved" })
  const attempt = await ports.store.latestIntegration(trainId)
  expect(await advanceTrain(ports.train, trainId)).toEqual({
    kind: "await_integration",
    integrationId: attempt!.input.id,
  })
  return attempt!.input.id
}

describe("Terminus integration orchestration", () => {
  it("does not recover failed evidence as success when the Train is already contained by Terminus", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const evidence = {
      checks: [{ name: "test", required: true, status: "failed" as const }],
    }
    // A crash after checkpointing failed checks but before recording failure.
    await ports.store.prepareIntegration(
      id,
      { repoId: id, headCommit: network.terminusCommit },
      evidence
    )
    const result = await failIntegration(
      integrationPorts(ports),
      id,
      "Lost failure acknowledgement"
    )
    expect(result).toMatchObject({
      ok: false,
      issues: [{ kind: "required_checks_failed" }],
    })
    expect((await ports.store.integration(id))!.status).toBe("failed")
  })
  it("grants one clearance, promotes, unloads, and bases the next attempt on current Terminus", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const one = await returning(ports, network.id)
    const two = await returning(ports, network.id)
    // Ask concurrently; the oldest eligible request wins, and the other waits.
    const moves = await Promise.all([
      advanceTrain(ports.train, one.id),
      advanceTrain(ports.train, two.id),
    ])
    expect(moves).toEqual([{ kind: "moved" }, { kind: "await_terminus" }])
    const first = (await ports.store.latestIntegration(one.id))!
    expect(await ports.store.latestIntegration(two.id)).toBeNull()
    const integration = integrationPorts(ports)
    await prepareIntegration(integration, first.input.id)
    await prepareIntegration(integration, first.input.id)
    const result = await promoteIntegration(integration, first.input.id)
    expect(result.ok).toBe(true)
    // Outcome is recovered from D1 even if the Workflow event is lost.
    await advanceTrain(ports.train, one.id)
    expect((await ports.store.train(one.id))!.value.state.status).toBe(
      "unloaded"
    )
    expect(await advanceTrain(ports.train, one.id)).toEqual({
      kind: "finished",
      status: "unloaded",
    })
    const canonical = (await ports.store.network(network.id))!.terminusCommit
    expect(
      await ports.store.claimIntegration({
        ...first.input,
        id: "stale-clearance",
        trainId: two.id,
        source: undefined,
      })
    ).toBeNull()
    const secondId = await clear(ports, two.id)
    expect(
      (await ports.store.integration(secondId))!.input.terminusCommit
    ).toBe(canonical)
    expect((await ports.store.integration(secondId))!.input.trainBaseline).toBe(
      network.terminusCommit
    )
    await prepareIntegration(integration, secondId)
    const second = await promoteIntegration(integration, secondId)
    await recordIntegrationOutcome(ports.train, two.id, {
      integrationId: secondId,
      result: second,
    })
    expect((await ports.store.train(two.id))!.value.state.status).toBe(
      "unloaded"
    )
    const before = await ports.store.lastSeq(network.id)
    await promoteIntegration(integration, secondId)
    await recordIntegrationOutcome(ports.train, two.id, {
      integrationId: secondId,
      result: second,
    })
    expect(await ports.store.lastSeq(network.id)).toBe(before)
    expect(
      (await ports.store.integrations(network.id)).map(
        (attempt) => attempt.status
      )
    ).toEqual(["completed", "completed"])
  })

  it("atomically rejects competing reservations, even outside normal Dispatcher ordering", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const one = await returning(ports, network.id)
    const two = await returning(ports, network.id)
    const id = await clear(ports, one.id)
    const input = (await ports.store.integration(id))!.input
    const before = await ports.store.lastSeq(network.id)
    const claims = await Promise.all([
      ports.store.claimIntegration({
        ...input,
        id: "competing-one",
        trainId: two.id,
        source: undefined,
      }),
      ports.store.claimIntegration({
        ...input,
        id: "competing-two",
        trainId: two.id,
        source: undefined,
      }),
    ])
    expect(claims).toEqual([null, null])
    expect(await ports.store.lastSeq(network.id)).toBe(before)
    await ports.store.finishIntegration(id, {
      ok: false,
      issues: [
        {
          kind: "integration_failed",
          detail: "Release reservation for contention test",
        },
      ],
    })
    const competing = await Promise.all([
      ports.store.claimIntegration({ ...input, id: "race-one" }),
      ports.store.claimIntegration({
        ...input,
        id: "race-two",
        trainId: two.id,
        source: undefined,
      }),
    ])
    expect(competing.filter(Boolean)).toHaveLength(1)
  })

  it.each(["failed", "missing"])(
    "does not promote %s project-wide evidence",
    async (mode) => {
      const ports = testPorts()
      const network = await seedNetwork(ports)
      const train = await returning(ports, network.id)
      const id = await clear(ports, train.id)
      const integration = integrationPorts(ports)
      integration.validator = {
        validate: async () => ({
          checks:
            mode === "missing"
              ? []
              : [{ name: "test", required: true, status: "failed" }],
        }),
      }
      const push = vi.spyOn(integration.repositories, "fastForward")
      await prepareIntegration(integration, id)
      const result = await promoteIntegration(integration, id)
      expect(result).toMatchObject({
        ok: false,
        issues: [{ kind: "required_checks_failed" }],
      })
      expect(push).not.toHaveBeenCalled()
      expect((await ports.store.network(network.id))!.terminusCommit).toBe(
        network.terminusCommit
      )
      await recordIntegrationOutcome(ports.train, train.id, {
        integrationId: id,
        result,
      })
      expect((await ports.store.train(train.id))!.value.state).toMatchObject({
        status: "blocked",
        resume: { status: "returning", phase: "awaiting_clearance" },
      })
      await clearTrain(ports.train, train.id)
      const retried = await clear(ports, train.id)
      expect(retried).not.toBe(id)
    }
  )

  it("records merge conflicts and raises a Train issue without promoting", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const integration = integrationPorts(ports)
    vi.spyOn(integration.repositories, "prepareIntegration").mockResolvedValue({
      ok: false,
      conflictPaths: ["src/shared.ts"],
    })
    await prepareIntegration(integration, id)
    const result = await promoteIntegration(integration, id)
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result,
    })
    const conflict = (await ports.store.conflicts(network.id))[0]!
    expect(conflict).toMatchObject({
      status: "open",
      paths: ["src/shared.ts"],
      trainIds: [train.id],
    })
    expect((await ports.store.network(network.id))!.terminusCommit).toBe(
      network.terminusCommit
    )
    const events = (await ports.store.eventsAfter(network.id, 0)).map(
      ({ event }) => event.type
    )
    expect(events).toContain("train.issue_raised")
    await clearTrain(ports.train, train.id)
    await advanceTrain(ports.train, train.id)
    expect((await ports.store.train(train.id))!.value.state.status).toBe(
      "blocked"
    )
    await resolveConflict(ports.dispatcher, network.id, conflict.id)
    await clearTrain(ports.train, train.id)
    expect(await advanceTrain(ports.train, train.id)).toEqual({ kind: "moved" })
  })

  it("defers new holds and resumes automatically when they clear", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const integration = integrationPorts(ports)
    await prepareIntegration(integration, id)
    const hold = await placeHold(ports.dispatcher, network.id, {
      kind: "user",
      scope: { kind: "train", trainId: train.id },
      note: "Wait",
    })
    const push = vi.spyOn(integration.repositories, "fastForward")
    const result = await promoteIntegration(integration, id)
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result,
    })
    expect(push).not.toHaveBeenCalled()
    expect((await ports.store.train(train.id))!.value.state.status).toBe("held")
    await releaseHold(ports.dispatcher, network.id, hold.id)
    expect(await advanceTrain(ports.train, train.id)).toEqual({ kind: "moved" })
    const next = await clear(ports, train.id)
    expect(next).not.toBe(id)
  })

  it("recovers a successful canonical push when D1 acknowledgement failed", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const integration = integrationPorts(ports)
    await prepareIntegration(integration, id)
    let head = network.terminusCommit
    vi.spyOn(integration.repositories, "head").mockImplementation(
      async () => head
    )
    const push = vi
      .spyOn(integration.repositories, "fastForward")
      .mockImplementation(async ({ toCommit }) => {
        head = toCommit
      })
    const finish = ports.store.finishIntegration.bind(ports.store)
    const save = vi
      .spyOn(ports.store, "finishIntegration")
      .mockRejectedValueOnce(new Error("Lost D1 acknowledgement"))
    await expect(promoteIntegration(integration, id)).rejects.toThrow("Lost D1")
    expect((await ports.store.integration(id))!.status).toBe("prepared")
    save.mockImplementation(finish)
    const result = await failIntegration(
      integration,
      id,
      "Workflow retry exhausted"
    )
    expect(result.ok).toBe(true)
    expect(push).toHaveBeenCalledTimes(1)
    expect((await ports.store.network(network.id))!.terminusCommit).toBe(head)
  })

  it("retains clearance if an uncertain push cannot be reconciled", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const integration = integrationPorts(ports)
    await prepareIntegration(integration, id)
    vi.spyOn(integration.repositories, "head").mockRejectedValue(
      new Error("Artifacts unavailable")
    )
    await expect(
      failIntegration(integration, id, "Lost response")
    ).rejects.toThrow("Artifacts unavailable")
    expect((await ports.store.integration(id))!.status).toBe("prepared")
    const interrupted = await ports.store.interruptIntegration(
      id,
      "Canonical write requires recovery"
    )
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result: interrupted,
    })
    expect((await ports.store.train(train.id))!.value.state.status).toBe(
      "blocked"
    )
    const other = await returning(ports, network.id)
    expect(await advanceTrain(ports.train, other.id)).toEqual({
      kind: "await_terminus",
    })
    const saved = (await ports.store.integration(id))!
    await ports.store.retryIntegration(id)
    await clearTrain(ports.train, train.id)
    expect(await clear(ports, train.id)).toBe(id)
    const recovered = (await ports.store.integration(id))!
    expect(recovered.candidate).toEqual(saved.candidate)
    expect(recovered.evidence).toEqual(saved.evidence)
    expect(recovered.result).toBeNull()
    vi.mocked(integration.repositories.head).mockResolvedValue(
      recovered.candidate!.headCommit
    )
    const result = await promoteIntegration(integration, id)
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result,
    })
    expect((await ports.store.train(train.id))!.value.state.status).toBe(
      "unloaded"
    )
  })

  it("ignores stale results from a previous integration attempt", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const train = await returning(ports, network.id)
    const id = await clear(ports, train.id)
    const integration = integrationPorts(ports)
    const failed = await failIntegration(
      integration,
      id,
      "Unavailable candidate"
    )
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result: failed,
    })
    await clearTrain(ports.train, train.id)
    const next = await clear(ports, train.id)
    const version = (await ports.store.train(train.id))!.version
    await recordIntegrationOutcome(ports.train, train.id, {
      integrationId: id,
      result: failed,
    })
    expect((await ports.store.train(train.id))!.version).toBe(version)
    expect((await ports.store.latestIntegration(train.id))!.input.id).toBe(next)
  })
})
