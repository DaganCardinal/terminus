import {
  eventsResponseSchema,
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
  it("runs the demo network until both Trains return", async () => {
    const network = await createNetwork()
    expect((await post(`/networks/${network.id}/demo`)).status).toBe(204)

    await waitUntil(async () => {
      const { trains } = await snapshot(network.id)
      return (
        trains.length === 2 &&
        trains.every(({ train }) => train.state.status === "returning")
      )
    })

    const final = await snapshot(network.id)
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
    expect(types).not.toContain("train.held")

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
    expect((await api("/networks/missing")).status).toBe(404)
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
})
