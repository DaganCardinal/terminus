import {
  eventsResponseSchema,
  integrationAttemptSchema,
  dispatchPlanSchema,
  repositoryFileSchema,
  repositoryOverviewSchema,
  type NetworkListing,
  type NetworkModelSettings,
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
  it("permanently deletes waiting Dispatcher and Train Workflows and their Network", async () => {
    const network = await createNetwork()
    await post(`/networks/${network.id}/holds`, {
      kind: "user",
      scope: { kind: "network" },
      note: "Hold for deletion test",
    })
    await post(`/networks/${network.id}/demo`)
    const planResponse = await post(`/networks/${network.id}/plans`, {
      requestId: crypto.randomUUID(),
      goal: "Disposable deletion test",
    })
    const plan = dispatchPlanSchema.parse(await planResponse.json())
    await waitUntil(async () => {
      const current = await snapshot(network.id)
      return (
        current.trains.length === 2 &&
        current.trains.every(({ train }) => train.state.status === "held") &&
        current.plans.some(
          (p) => p.id === plan.id && p.state.status === "ready"
        )
      )
    })
    const before = await snapshot(network.id)
    const remove = () =>
      api(`/networks/${network.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: '{"confirm":true}',
      })
    const response = await remove()
    expect(response.status, await response.text()).toBe(204)
    expect((await api(`/networks/${network.id}`)).status).toBe(404)
    await expect(env.DISPATCH_WORKFLOW.get(plan.id)).rejects.toThrow(
      "instance.not_found"
    )
    for (const { train } of before.trains)
      await expect(env.TRAIN_WORKFLOW.get(train.id)).rejects.toThrow(
        "instance.not_found"
      )
    expect((await api(`/networks/${network.id}/events?after=0`)).status).toBe(
      404
    )
    expect((await remove()).status).toBe(204)
  }, 20_000)
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
  it("checks the baseline on request and lets the user reject the suggested fix before launch", async () => {
    const network = await createNetwork()
    const response = await post(`/networks/${network.id}/plans`, {
      requestId: crypto.randomUUID(),
      goal: "Add a footer",
      checkBaseline: true,
    })
    const plan = dispatchPlanSchema.parse(await response.json())
    expect(plan.checkBaseline).toBe(true)
    await waitUntil(
      async () =>
        (await snapshot(network.id)).plans[0]?.state.status === "ready"
    )
    const ready = (await snapshot(network.id)).plans[0]!
    if (ready.state.status !== "ready") throw new Error("Expected ready")
    expect(ready.state.baseline?.checks.length).toBeGreaterThan(0)
    expect(ready.state.proposal.baselineFix).toBeDefined()
    const select = (selection: string) =>
      api(`/networks/${network.id}/plans/${plan.id}/baseline-fix`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection }),
      })
    expect((await select("maybe")).status).toBe(400)
    const rejected = dispatchPlanSchema.parse(
      await (await select("reject")).json()
    )
    if (rejected.state.status !== "ready") throw new Error("Expected ready")
    expect(rejected.state.proposal.baselineFix?.selection).toBe("reject")
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
  }, 20_000)
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

  it("validates preview stop requests and reports fake mode", async () => {
    const network = await createNetwork()
    await post(`/networks/${network.id}/demo`)
    const { trains } = await snapshot(network.id)
    const stop = (path: string, body: unknown) =>
      api(path, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const commit = { commit: "a".repeat(40) }
    for (const path of [
      `/networks/${network.id}/preview`,
      `/trains/${trains[0]!.train.id}/preview`,
    ]) {
      expect((await stop(path, {})).status).toBe(400)
      expect((await stop(path, { commit: "main" })).status).toBe(400)
      const simulated = await stop(path, commit)
      expect(simulated.status).toBe(503)
      expect(await simulated.json()).toMatchObject({
        error: expect.stringContaining("fake mode"),
      })
    }
    expect((await stop("/networks/missing/preview", commit)).status).toBe(404)
    expect((await stop("/trains/missing/preview", commit)).status).toBe(404)
  })
})

describe("model settings", () => {
  const put = (path: string, body: unknown) =>
    api(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("saves General settings and lets a network override or follow them", async () => {
    const network = await createNetwork()
    expect(await (await api("/settings/models")).json()).toMatchObject({
      settings: { preset: "extra_light" },
    })

    expect((await put("/settings/models", { preset: "light" })).status).toBe(
      200
    )
    const path = `/networks/${network.id}/settings/models`
    expect(await (await api(path)).json()).toEqual({
      override: null,
      general: { preset: "light" },
      updatedAt: null,
      alternativeHarnessesEnabled: true,
    })

    const models = {
      dispatcher: "@cf/zai-org/glm-5.3",
      conductor: "@cf/zai-org/glm-5.3",
      stationAgent: "@cf/moonshotai/kimi-k2.7-code",
      technician: "@cf/zai-org/glm-5.3-flash",
      engineer: "@cf/cloudflare/clef",
    }
    const saved = await put(path, { override: { preset: "custom", models } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      override: { preset: "custom", models },
      general: { preset: "light" },
    })

    const cleared: NetworkModelSettings = await (
      await put(path, { override: null })
    ).json()
    expect(cleared.override).toBeNull()
    await put("/settings/models", { preset: "extra_light" })
  })

  it("refuses an Engineer that is not Clef, unknown presets, and unknown networks", async () => {
    const network = await createNetwork()
    const path = `/networks/${network.id}/settings/models`
    expect(
      (
        await put(path, {
          override: {
            preset: "custom",
            models: {
              dispatcher: "@cf/zai-org/glm-5.3",
              conductor: "@cf/zai-org/glm-5.3",
              stationAgent: "@cf/zai-org/glm-5.3",
              technician: "@cf/zai-org/glm-5.3",
              engineer: "@cf/zai-org/glm-5.3",
            },
          },
        })
      ).status
    ).toBe(400)
    expect((await put("/settings/models", { preset: "heavy" })).status).toBe(
      400
    )
    expect((await api("/networks/missing/settings/models")).status).toBe(404)
    expect(
      (
        await put("/networks/missing/settings/models", {
          override: { preset: "light" },
        })
      ).status
    ).toBe(404)
  })
})

describe("sandbox limits", () => {
  const put = (path: string, body: unknown) =>
    api(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("saves General limits and lets a network override or follow them", async () => {
    const network = await createNetwork()
    expect(await (await api("/settings/sandboxes")).json()).toEqual({
      limits: {
        agent: 10,
        agentless: 10,
        sizes: { agent: "standard-2", agentless: "standard-2" },
      },
      updatedAt: null,
    })
    const general = {
      agent: 4,
      agentless: 12,
      sizes: { agent: "standard-3", agentless: "standard-1" },
    }
    expect((await put("/settings/sandboxes", general)).status).toBe(200)

    const path = `/networks/${network.id}/settings/sandboxes`
    expect(await (await api(path)).json()).toEqual({
      override: null,
      general,
      updatedAt: null,
    })
    const override = {
      agent: 20,
      agentless: 2,
      sizes: { agent: "standard-1", agentless: "standard-2" },
    }
    const saved = await put(path, { override })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ override, general })

    expect(await (await put(path, { override: null })).json()).toMatchObject({
      override: null,
      general,
    })
    await put("/settings/sandboxes", { agent: 10, agentless: 10 })
  })

  it("refuses limits outside 1 to 100, partial limits, unknown sizes, and unknown networks", async () => {
    for (const limits of [
      { agent: 0, agentless: 10 },
      { agent: 10, agentless: 101 },
      { agent: 2.5, agentless: 10 },
      { agent: 10 },
      {
        agent: 10,
        agentless: 10,
        sizes: { agent: "basic", agentless: "standard-1" },
      },
      { agent: 10, agentless: 10, sizes: { agent: "standard-2" } },
    ])
      expect((await put("/settings/sandboxes", limits)).status).toBe(400)
    expect((await api("/networks/missing/settings/sandboxes")).status).toBe(404)
    expect(
      (
        await put("/networks/missing/settings/sandboxes", {
          override: { agent: 1, agentless: 1 },
        })
      ).status
    ).toBe(404)
  })
})

describe("browsing networks", () => {
  it("lists networks with their upstream source and activity", async () => {
    const response = await post("/networks", {
      name: "Imported",
      sourceUrl: "https://github.com/owner/project.git",
    })
    const network: NetworkSummary = await response.json()
    expect(network.sourceUrl).toBe("https://github.com/owner/project.git")

    const listings: NetworkListing[] = await (await api("/networks")).json()
    const listing = listings.find((entry) => entry.id === network.id)
    expect(listing).toMatchObject({
      sourceUrl: "https://github.com/owner/project.git",
      activity: {
        lines: 0,
        trains: {},
        activeLines: [],
        stations: { total: 0, complete: 0 },
        cars: 0,
        openConflicts: 0,
        plansAwaitingLaunch: 0,
        lastPromotion: null,
        promotions: 0,
      },
    })
    expect(await (await api(`/networks/${network.id}/summary`)).json()).toEqual(
      listing
    )
    expect((await api("/networks/network-missing/summary")).status).toBe(404)
  })

  it("gives each network its own namespace and refuses a second network for the same project", async () => {
    const first = await post("/networks", {
      name: "App",
      sourceUrl: "https://github.com/owner/app.git",
    })
    expect(first.status).toBe(201)
    const network: NetworkSummary = await first.json()
    expect(network.terminusRepoId).toBe(`terminus-${network.id}/terminus`)

    for (const sourceUrl of [
      "https://github.com/owner/app.git",
      "https://GitHub.com/owner/app/",
      "https://github.com/owner/app",
    ]) {
      const again = await post("/networks", { name: "App again", sourceUrl })
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({
        error: "This project already has a network: App",
        details: { networkId: network.id },
      })
    }

    const other = await post("/networks", {
      name: "Other",
      sourceUrl: "https://github.com/owner/other.git",
    })
    expect(other.status).toBe(201)
    const empty: NetworkSummary[] = await Promise.all(
      [1, 2].map(async () =>
        (await post("/networks", { name: "Empty" })).json()
      )
    )
    expect(new Set(empty.map((entry) => entry.terminusRepoId)).size).toBe(2)
  })

  it("reads Terminus documents and files, caching only commit-pinned reads", async () => {
    const network = await createNetwork()
    const latest = await api(`/networks/${network.id}/repository`)
    expect(latest.headers.get("cache-control")).toBe("no-store")
    const overview = repositoryOverviewSchema.parse(await latest.json())
    expect(overview.commit).toBe(network.terminusCommit)
    expect(overview.documents[0]?.path).toBe("README.md")

    const pinned = await api(
      `/networks/${network.id}/repository/file?commit=${network.terminusCommit}&path=src/App.tsx`
    )
    expect(pinned.headers.get("cache-control")).toContain("immutable")
    expect(repositoryFileSchema.parse(await pinned.json())).toMatchObject({
      path: "src/App.tsx",
      content: expect.stringContaining("export function App"),
    })
    expect(
      (
        await api(
          `/networks/${network.id}/repository/file?commit=${network.terminusCommit}&path=missing.ts`
        )
      ).status
    ).toBe(404)
    expect(
      (await api(`/networks/${network.id}/repository/file?path=src/App.tsx`))
        .status
    ).toBe(400)
  })
})

it("runs the Crossing demo through real Workflows and unloads both Trains", async () => {
  const network = await createNetwork()
  expect((await post(`/networks/${network.id}/demo/crossings`)).status).toBe(
    200
  )
  await waitUntil(async () => {
    const s = await snapshot(network.id)
    return (
      s.trains.length === 2 &&
      s.trains.every((t) => t.train.state.status === "unloaded")
    )
  }, 25000)
  const s = await snapshot(network.id),
    c = s.crossings![0]!
  expect(c.state.status).toBe("complete")
  expect(c.checkpoint?.carIds).toHaveLength(2)
  const copied = s.cars.filter((car) => car.crossingId === c.id)
  expect(copied).toHaveLength(2)
  expect(
    s.cars.filter(
      (car) =>
        car.trainId ===
        s.trains.find((t) => t.train.lineId === c.lineId)!.train.id
    )
  ).toHaveLength(4)
  const detail = await api(`/crossings/${c.id}`)
  expect(detail.status).toBe(200)
  const body: { attempts: { review: { verdict: string } }[] } =
    await detail.json()
  expect(body.attempts[0]!.review.verdict).toBe("accept")
  expect((await post(`/crossings/${c.id}/retry`)).status).toBe(409)
})

it.each([
  { direct: false, crossing: false },
  { direct: true, crossing: false },
  { direct: false, crossing: true },
])(
  "runs Junction convergence, human release, and final integration with direct=$direct, crossing=$crossing",
  async ({ direct, crossing }) => {
    const junctionIntrospector = await introspectWorkflow(env.JUNCTION_WORKFLOW)
    introspectors.push(junctionIntrospector)
    const network = await createNetwork()
    const response = await post(
      `/networks/${network.id}/demo/junctions?direct=${direct}&crossing=${crossing}`
    )
    expect(response.status).toBe(201)
    const j: {
      id: string
      outgoingTrainId: string
      incomingTrainIds: string[]
      terminusBaseline: string
    } = await response.json()
    await waitUntil(async () => {
      const s = await snapshot(network.id)
      return (
        s.junctions?.[0]?.state.status === "ready" &&
        s.trains.every((t) => t.train.state.status === "unloaded")
      )
    }, 30000)
    const before = await snapshot(network.id)
    expect(before.network.terminusCommit).not.toBe(j.terminusBaseline)
    expect(before.trains.some((t) => t.train.id === j.outgoingTrainId)).toBe(
      false
    )
    for (const id of j.incomingTrainIds)
      expect(
        before.trains.find((t) => t.train.id === id)?.train.state
      ).toMatchObject({
        status: "unloaded",
        destination: { kind: "junction", junctionId: j.id },
      })
    const head = before.junctions![0]!.headCommit
    expect(
      (await post(`/junctions/${j.id}/release`, { commit: "stale" })).status
    ).toBe(409)
    expect(
      (await post(`/junctions/${j.id}/release`, { commit: head })).status
    ).toBe(202)
    expect(
      (await post(`/junctions/${j.id}/release`, { commit: head })).status
    ).toBe(202)
    await waitUntil(
      async () =>
        (await snapshot(network.id)).trains.find(
          (t) => t.train.id === j.outgoingTrainId
        )?.train.state.status === "unloaded",
      30000
    )
    const after = await snapshot(network.id)
    expect(
      after.trains.filter((t) => t.train.id === j.outgoingTrainId)
    ).toHaveLength(1)
    expect(
      after.cars.filter((c) => c.trainId === j.outgoingTrainId && c.junctionId)
    ).toHaveLength(crossing ? 4 : 3)
    const events = eventsResponseSchema.parse(
      await (await api(`/networks/${network.id}/events?after=0`)).json()
    ).events
    expect(
      events.filter((e) => e.event.type === "terminus.promoted")
    ).toHaveLength(2)
    expect(
      events.filter((e) => e.event.type === "junction.released")
    ).toHaveLength(1)
    expect((await api(`/junctions/${j.id}`)).status).toBe(200)
  }
)
