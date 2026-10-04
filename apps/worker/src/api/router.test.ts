import {
  eventsResponseSchema,
  integrationAttemptSchema,
  dispatchPlanSchema,
  type NetworkSnapshot,
  type NetworkSummary,
} from "@terminus/protocol"
import {
  SELF,
  introspectWorkflow,
  type WorkflowIntrospector,
} from "cloudflare:test"
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { manifest } from "../../test/fixtures"

const base = "https://terminus.test/api"
let introspectors: WorkflowIntrospector[] = []
beforeEach(async () => {
  introspectors = await Promise.all([
    introspectWorkflow(env.TRAIN_WORKFLOW),
    introspectWorkflow(env.STATION_WORKFLOW),
    introspectWorkflow(env.INTEGRATION_WORKFLOW),
    introspectWorkflow(env.DISPATCH_WORKFLOW),
  ])
})
afterEach(async () => {
  await Promise.all(introspectors.map((instance) => instance.dispose()))
})

async function api(path: string, init?: RequestInit) {
  return SELF.fetch(`${base}${path}`, init)
}

async function post(path: string, body?: unknown) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createNetwork(): Promise<NetworkSummary> {
  const response = await post("/networks", { name: "Demo" })
  expect(response.status).toBe(201)
  const network: NetworkSummary = await response.json()
  return network
}

async function snapshot(networkId: string): Promise<NetworkSnapshot> {
  return (await api(`/networks/${networkId}`)).json()
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await scheduler.wait(100)
  }
}

describe("the API with real Workflows", () => {
  it("removes a rejected Station through its Train Workflow and resumes the Line", async () => {
    const network = await createNetwork()
    const response = await post(`/networks/${network.id}/lines`, {
      name: "Legacy Line",
      stations: [
        {
          key: "verify",
          name: "Verify only",
          manifest: manifest({ repositoryChange: undefined }),
        },
      ],
    })
    expect(response.status).toBe(201)
    await waitUntil(
      async () =>
        (await snapshot(network.id)).trains[0]?.train.state.status === "blocked"
    )
    const before = await snapshot(network.id)
    const stationId = before.stations[0]!.id
    expect(before.stations[0]!.state.status).toBe("waiting")
    expect(
      (
        await post(`/networks/${network.id}/stations/${stationId}/remove`, {
          reason: " ",
        })
      ).status
    ).toBe(400)
    const other = await createNetwork()
    expect(
      (
        await post(`/networks/${other.id}/stations/${stationId}/remove`, {
          reason: "Remove",
        })
      ).status
    ).toBe(404)
    expect(
      (
        await post(`/networks/${network.id}/stations/${stationId}/remove`, {
          reason: "Checks are already covered",
        })
      ).status
    ).toBe(202)
    await waitUntil(
      async () =>
        (await snapshot(network.id)).trains[0]?.train.state.status ===
        "unloaded"
    )
    const after = await snapshot(network.id)
    expect(after.stations[0]!.state).toEqual({
      status: "cancelled",
      reason: "Checks are already covered",
    })
    expect(after.lines[0]!.stationIds).toEqual(before.lines[0]!.stationIds)
    expect(after.cars).toHaveLength(0)
    const events = eventsResponseSchema.parse(
      await (await api(`/networks/${network.id}/events?after=0`)).json()
    ).events
    expect(events.map((e) => e.event.type)).toContain(
      "station.removal_requested"
    )
    expect(events.map((e) => e.event.type)).toContain("station.cancelled")
    expect(events.map((e) => e.event.type)).not.toContain("station.signaled")
  }, 20_000)
  it("persists a proposal, waits for explicit launch, and runs the planned Train to Terminus", async () => {
    const network = await createNetwork()
    const request = {
      requestId: crypto.randomUUID(),
      goal: "Add an accessible footer with tests",
    }
    const response = await post(`/networks/${network.id}/plans`, request)
    expect(response.status).toBe(202)
    const plan = dispatchPlanSchema.parse(await response.json())
    expect(plan.model).toBe("fake")
    expect((await post(`/networks/${network.id}/plans`, request)).status).toBe(
      202
    )
    await waitUntil(
      async () =>
        (await snapshot(network.id)).plans[0]?.state.status === "ready"
    )
    const proposed = await snapshot(network.id)
    expect(proposed.plans).toHaveLength(1)
    expect(proposed.lines).toHaveLength(0)
    expect(proposed.trains).toHaveLength(0)
    const wrongNetwork = await createNetwork()
    expect(
      (await post(`/networks/${wrongNetwork.id}/plans/${plan.id}/launch`))
        .status
    ).toBe(404)
    const launched = await post(
      `/networks/${network.id}/plans/${plan.id}/launch`
    )
    expect(launched.status).toBe(202)
    dispatchPlanSchema.parse(await launched.json())
    expect(
      (await post(`/networks/${network.id}/plans/${plan.id}/launch`)).status
    ).toBe(202)
    await waitUntil(async () => {
      const current = await snapshot(network.id)
      return (
        current.plans[0]?.state.status === "launched" &&
        current.trains.length === 1 &&
        current.trains[0]!.train.state.status === "unloaded"
      )
    })
    const final = await snapshot(network.id)
    expect(final.lines).toHaveLength(1)
    expect(final.cars).toHaveLength(1)
    expect(final.stations[0]!.manifest.goal).toBe(request.goal)
    expect(
      (await post(`/networks/${network.id}/plans/${plan.id}/retry`)).status
    ).toBe(409)
    const { events } = eventsResponseSchema.parse(
      await (await api(`/networks/${network.id}/events?after=0`)).json()
    )
    expect(
      events.filter((e) => e.event.type === "dispatcher.plan_requested")
    ).toHaveLength(1)
    expect(
      events.filter((e) => e.event.type === "dispatcher.plan_launched")
    ).toHaveLength(1)
  }, 20_000)
  it("unloads one demo Train automatically and waits for explicit approval of the other", async () => {
    const network = await createNetwork()
    expect(
      (await post(`/networks/${network.id}/plans`, { goal: "Goal" })).status
    ).toBe(400)
    expect(
      (
        await post(`/networks/${network.id}/plans`, {
          requestId: crypto.randomUUID(),
          goal: " ",
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post(`/networks/missing/plans`, {
          requestId: crypto.randomUUID(),
          goal: "Goal",
        })
      ).status
    ).toBe(404)
    expect(
      (await post(`/networks/${network.id}/plans/missing/retry`)).status
    ).toBe(404)
    expect((await post(`/networks/${network.id}/demo`)).status).toBe(204)

    await waitUntil(async () => {
      const current = await snapshot(network.id)
      return (
        current.trains.length === 2 &&
        current.trains.some(({ train }) => train.state.status === "unloaded") &&
        current.trains.some(({ train }) => train.state.status === "held")
      )
    })
    const waiting = await snapshot(network.id)
    const review = waiting.trains.find(
      ({ train }) => train.state.status === "held"
    )!.train
    expect(
      waiting.unloadPolicies?.find((p) => p.trainId === review.id)?.mode
    ).toBe("human_approval")
    expect(
      (await (
        await api(`/networks/${network.id}/integrations`)
      ).json()) as unknown[]
    ).toHaveLength(1)
    expect(
      (
        await post(`/trains/${review.id}/approve-unload`, {
          trainCommit: "stale",
        })
      ).status
    ).toBe(409)
    expect(
      (
        await post(`/trains/${review.id}/approve-unload`, {
          trainCommit: review.headCommit,
          mode: "auto",
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post(`/trains/${review.id}/approve-unload`, {
          trainCommit: review.headCommit,
        })
      ).status
    ).toBe(200)
    await waitUntil(async () =>
      (await snapshot(network.id)).trains.every(
        ({ train }) => train.state.status === "unloaded"
      )
    )

    const final = await snapshot(network.id)
    const attempts = integrationAttemptSchema
      .array()
      .parse(await (await api(`/networks/${network.id}/integrations`)).json())
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => attempt.status === "completed")).toBe(
      true
    )
    expect(attempts[0]!.input.terminusCommit).toBe(network.terminusCommit)
    expect(attempts[1]!.input.terminusCommit).toBe(
      attempts[0]!.candidate!.headCommit
    )
    expect(final.network.terminusCommit).toBe(
      attempts[1]!.candidate!.headCommit
    )
    expect(
      (await post(`/integrations/${attempts[0]!.input.id}/retry`)).status
    ).toBe(409)
    expect(final.cars).toHaveLength(3)
    expect(final.stations.every((s) => s.state.status === "complete")).toBe(
      true
    )

    const response = await api(`/networks/${network.id}/events?after=0`)
    const { events, lastSeq } = eventsResponseSchema.parse(
      await response.json()
    )
    expect(lastSeq).toBe(final.lastSeq)
    const types = events.map((envelope) => envelope.event.type)
    expect(types.filter((type) => type === "train.departed")).toHaveLength(3)
    expect(types).toContain("train.held")
    expect(
      types.filter((type) => type === "train.unload_approved")
    ).toHaveLength(1)
    expect(types.filter((type) => type === "terminus.promoted")).toHaveLength(2)
    expect(types.filter((type) => type === "train.unloaded")).toHaveLength(2)

    const later = await api(`/networks/${network.id}/events?after=${lastSeq}`)
    expect(await later.json()).toEqual({ events: [], lastSeq })
  })
})

describe("API validation", () => {
  it("rejects invalid requests", async () => {
    expect((await post("/networks", { name: "" })).status).toBe(400)
    expect((await post("/networks", undefined)).status).toBe(400)

    const network = await createNetwork()
    const invalid = await post(`/networks/${network.id}/lines`, {
      name: "Bad",
      stations: [
        {
          key: "a",
          name: "A",
          manifest: manifest({ dependencies: ["nowhere"] }),
        },
      ],
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: "Unknown dependencies: nowhere",
    })
    expect((await api(`/networks/${network.id}/events?after=-1`)).status).toBe(
      400
    )
  })

  it("returns 404 for unknown networks and routes", async () => {
    expect(
      (await post("/networks/missing/preview", { commit: "a".repeat(40) }))
        .status
    ).toBe(404)
    expect((await post("/trains/missing/preview")).status).toBe(404)
    expect((await api("/networks/missing")).status).toBe(404)
    expect((await api("/networks/missing/integrations")).status).toBe(404)
    expect((await post("/integrations/missing/retry")).status).toBe(404)
    expect(
      (await post("/networks/missing/conflicts/missing/resolve")).status
    ).toBe(404)
    expect((await post("/networks/missing/demo")).status).toBe(404)
    expect((await api("/nowhere")).status).toBe(404)
  })

  it("refuses to clear a Train that is not blocked", async () => {
    const network = await createNetwork()
    await post(`/networks/${network.id}/demo`)
    const { trains } = await snapshot(network.id)
    const response = await post(`/trains/${trains[0]!.train.id}/clear`)
    expect(response.status).toBe(409)
  })

  it("reports that fake Trains have no real app to preview", async () => {
    const network = await createNetwork()
    await post(`/networks/${network.id}/demo`)
    const { trains } = await snapshot(network.id)
    const response = await post(`/trains/${trains[0]!.train.id}/preview`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("fake mode"),
    })
  })

  it("validates Terminus preview requests, refuses stale commits, and reports fake mode without changing the network", async () => {
    const network = await createNetwork()
    const before = await snapshot(network.id)
    for (const body of [
      {},
      { commit: "" },
      { commit: network.terminusCommit, repoId: "another-repo" },
    ])
      expect((await post(`/networks/${network.id}/preview`, body)).status).toBe(
        400
      )
    const stale = await post(`/networks/${network.id}/preview`, {
      commit: "a".repeat(40),
    })
    expect(stale.status).toBe(409)
    const simulated = await post(`/networks/${network.id}/preview`, {
      commit: network.terminusCommit,
    })
    expect(simulated.status).toBe(503)
    expect(await simulated.json()).toMatchObject({
      error: expect.stringContaining("fake mode"),
    })
    expect(await snapshot(network.id)).toEqual(before)
  })
})
