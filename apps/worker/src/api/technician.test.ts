import {
  SELF,
  env,
  introspectWorkflow,
  type WorkflowIntrospector,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  technicianRepairSchema,
  eventsResponseSchema,
} from "@terminus/protocol"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import { prepareIntegration } from "../workflows/integration-operations"
import { advanceTrain } from "../workflows/train-operations"

let introspectors: WorkflowIntrospector[] = []
beforeEach(async () => {
  introspectors = await Promise.all([
    introspectWorkflow(env.TECHNICIAN_WORKFLOW),
    introspectWorkflow(env.TRAIN_WORKFLOW),
    introspectWorkflow(env.INTEGRATION_WORKFLOW),
  ])
})
afterEach(async () => {
  await Promise.all(introspectors.map((instance) => instance.dispose()))
  vi.restoreAllMocks()
})
const post = (path: string) =>
  SELF.fetch(`https://terminus.test/api${path}`, { method: "POST" })
async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await scheduler.wait(100)
  }
}

describe("Technician API with real Workflows and offline roles", () => {
  it("executes a repair without a browser and waits for explicit approval before promoting", async () => {
    const ports = testPorts()
    const network = await seedNetwork(ports)
    const { train } = await seedLine(ports, network.id)
    await drive(ports, train.id)
    await advanceTrain(ports.train, train.id)
    vi.spyOn(ports.train.repositories, "prepareIntegration").mockResolvedValue({
      ok: false,
      conflictPaths: ["src/shared.ts"],
    })
    const attempt = (await ports.store.latestIntegration(train.id))!
    await prepareIntegration(
      {
        store: ports.store,
        repositories: ports.train.repositories,
        validator: new FakeIntegrationValidator(),
      },
      attempt.input.id
    )
    await advanceTrain(ports.train, train.id)
    await env.TRAIN_WORKFLOW.create({
      id: train.id,
      params: { trainId: train.id },
    })
    const conflict = (await ports.store.conflicts(network.id))[0]!
    const response = await post(
      `/networks/${network.id}/conflicts/${conflict.id}/technician`
    )
    expect(response.status).toBe(202)
    const repair = technicianRepairSchema.parse(await response.json())
    await waitUntil(
      async () =>
        (await ports.store.repair(repair.id))?.value.state.status === "ready"
    )
    expect((await ports.store.train(train.id))!.value.state.status).toBe(
      "blocked"
    )
    expect((await ports.store.network(network.id))!.terminusCommit).toBe(
      network.terminusCommit
    )
    const wrongNetwork = await post(
      `/networks/wrong/repairs/${repair.id}/approve`
    )
    expect(wrongNetwork.status).toBe(404)
    expect(
      (await post(`/networks/${network.id}/repairs/${repair.id}/approve`))
        .status
    ).toBe(202)
    await waitUntil(
      async () =>
        (await ports.store.train(train.id))?.value.state.status === "unloaded"
    )
    expect((await ports.store.repair(repair.id))!.value.state.status).toBe(
      "integrated"
    )
    expect((await ports.store.conflicts(network.id))[0]!.status).toBe(
      "resolved"
    )
    expect(
      (await post(`/networks/${network.id}/repairs/${repair.id}/approve`))
        .status
    ).toBe(202)
    const events = eventsResponseSchema.parse(
      await (
        await SELF.fetch(
          `https://terminus.test/api/networks/${network.id}/events`
        )
      ).json()
    )
    expect(events.events.map((row) => row.event.type)).toContain(
      "technician.validated"
    )
    expect(events.events.map((row) => row.event.type)).toContain(
      "technician.integrated"
    )
  })
  it("rejects missing or unsupported conflicts and repairs", async () => {
    expect(
      (await post("/networks/missing/conflicts/missing/technician")).status
    ).toBe(404)
    expect(
      (await post("/networks/missing/repairs/missing/approve")).status
    ).toBe(404)
  })
})
