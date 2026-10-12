import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { FakeDispatchPlanner } from "@terminus/agent-runtime"
import {
  proposeDispatchPlan,
  type DispatchPlanningPorts,
} from "../agents/dispatch-planning"
import { prepareDispatchPlan } from "../workflows/dispatch-operations"
import { seedNetwork, testPorts } from "../../test/fixtures"
import { handleApi } from "../api/router"
import { DispatchActivityStore } from "./dispatch-activity"

async function fixture() {
  const base = testPorts(),
    network = await seedNetwork(base)
  const store = new DispatchActivityStore(env.DB)
  const ports: DispatchPlanningPorts = {
    ...base.dispatcher,
    activity: store,
    planner: new FakeDispatchPlanner(),
    startPlanning: async () => {},
    wakePlan: async () => {},
    retryPlan: async () => {},
  }
  const plan = await proposeDispatchPlan(ports, network.id, {
    goal: "Activity test",
    requestId: crypto.randomUUID(),
  })
  return { store, ports, plan, network }
}
const at = "2026-10-12T12:00:00.000Z"

describe("durable Dispatcher activity", () => {
  it("respects the Network deletion fence", async () => {
    const f = await fixture(),
      recorder = await f.store.begin(f.plan.id)
    await env.DB.prepare("UPDATE networks SET deleting = 1 WHERE id = ?")
      .bind(f.network.id)
      .run()
    await expect(f.store.begin(f.plan.id)).rejects.toThrow("network_deleting")
    await expect(
      f.store.append(f.plan.id, recorder.attempt, [
        { position: 1, at, activity: { kind: "phase", phase: "exploring" } },
      ])
    ).rejects.toThrow("network_deleting")
    await recorder.close()
  })
  it("bounds and pages history, retaining the current phase", async () => {
    const f = await fixture(),
      recorder = await f.store.begin(f.plan.id)
    await f.store.append(f.plan.id, recorder.attempt, [
      { position: 1, at, activity: { kind: "phase", phase: "exploring" } },
      ...Array.from({ length: 210 }, (_, i) => ({
        position: i + 2,
        at,
        activity: {
          kind: "tool" as const,
          tool: "read" as const,
          status: "completed" as const,
          path: "src/a.ts",
        },
      })),
    ])
    const first = await f.store.read(f.plan.id, 0),
      second = await f.store.read(f.plan.id, first.lastSeq)
    expect(first.entries).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(second.entries).toHaveLength(100)
    expect(second.hasMore).toBe(false)
    expect(first.entries[0]?.activity).toEqual({
      kind: "phase",
      phase: "exploring",
    })
    expect(second.entries[0]!.seq).toBeGreaterThan(first.lastSeq)
    const again = await f.store.read(f.plan.id, second.lastSeq)
    expect(again.entries).toEqual([])
    expect(again.lastSeq).toBe(second.lastSeq)
    // Replaying a batch cannot add duplicate records.
    await f.store.append(f.plan.id, recorder.attempt, [
      {
        position: 211,
        at,
        activity: { kind: "tool", tool: "read", status: "completed" },
      },
    ])
    expect((await f.store.read(f.plan.id, second.lastSeq)).entries).toEqual([])
    await recorder.close()
  })

  it("fences late updates from an older attempt and cascades on plan deletion", async () => {
    const f = await fixture(),
      old = await f.store.begin(f.plan.id)
    old.observe({ kind: "phase", phase: "exploring" })
    const current = await f.store.begin(f.plan.id)
    current.observe({ kind: "phase", phase: "starting_agent" })
    await current.close()
    await old.close()
    const page = await f.store.read(f.plan.id, 0)
    expect(page.attempt).toBe(current.attempt)
    expect(page.entries.map((e) => e.activity)).toEqual([
      { kind: "phase", phase: "starting_agent" },
    ])
    await env.DB.prepare("DELETE FROM dispatch_plans WHERE id = ?")
      .bind(f.plan.id)
      .run()
    expect(await f.store.read(f.plan.id, 0)).toEqual({
      attempt: null,
      entries: [],
      lastSeq: 0,
      hasMore: false,
    })
  })

  it("records real planning observations and leaves planning intact if activity writes fail", async () => {
    const f = await fixture()
    await prepareDispatchPlan(f.ports, f.plan.id)
    expect(
      (await f.store.read(f.plan.id, 0)).entries.map((e) => e.activity)
    ).toEqual([
      { kind: "phase", phase: "simulation" },
      { kind: "phase", phase: "saving_proposal" },
    ])
    expect(
      (await f.ports.store.dispatchPlan(f.plan.id))?.value.state.status
    ).toBe("ready")
    const failed = await fixture()
    vi.spyOn(failed.store, "append").mockRejectedValue(
      new Error("DB unavailable PRIVATE")
    )
    await prepareDispatchPlan(failed.ports, failed.plan.id)
    expect(
      (await failed.ports.store.dispatchPlan(failed.plan.id))?.value.state
        .status
    ).toBe("ready")
  })

  it("checks plan ownership and cursor validity without exposing another network's activity", async () => {
    const f = await fixture(),
      recorder = await f.store.begin(f.plan.id)
    recorder.observe({ kind: "phase", phase: "exploring" })
    await recorder.close()
    const url = `https://terminus.test/api/networks/${f.network.id}/plans/${f.plan.id}/activity`
    const response = await handleApi(new Request(url), env)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(
      ((await response.json()) as { entries: unknown[] }).entries
    ).toHaveLength(1)
    const wrong = url.replace(f.network.id, "other-network")
    expect((await handleApi(new Request(wrong), env)).status).toBe(404)
    for (const cursor of ["-1", "NaN", "1.5", "9007199254740992"])
      expect(
        (await handleApi(new Request(`${url}?after=${cursor}`), env)).status
      ).toBe(400)
  })
})
