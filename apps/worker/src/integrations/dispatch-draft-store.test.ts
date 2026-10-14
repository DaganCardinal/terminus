import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { PlanDraft, PlanStation } from "@terminus/protocol"
import { seedDispatchPlan } from "../../test/fixtures"
import { DispatchDraftStore } from "./dispatch-draft-store"

const station = (key: string, goal = `Deliver ${key}`): PlanStation => ({
  key,
  name: `Station ${key}`,
  goal,
  changeKind: "implementation",
  changeDescription: `Implement ${key}`,
  scope: [`Only ${key}`],
  expectedAreas: [`src/${key}.ts`],
  acceptanceCriteria: [`${key} works`],
})
const outline = {
  summary: "One Line.",
  lines: [
    {
      key: "footer",
      name: "Footer",
      unloadRecommendation: { mode: "auto" as const, reason: "Small." },
      stations: ["a", "b"],
    },
  ],
}

async function rows(planId: string) {
  const { results } = await env.DB.prepare(
    "SELECT part, key, updated_at FROM dispatch_drafts WHERE plan_id = ? ORDER BY part, key"
  )
    .bind(planId)
    .all<{ part: string; key: string; updated_at: string }>()
  return results
}

describe("Dispatcher draft store", () => {
  it("saves one row per piece and reads the draft back", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    expect(await store.read(plan.id)).toEqual({ stations: {} })
    const draft: PlanDraft = {
      outline,
      stations: { a: station("a"), b: station("b") },
    }
    await store.save(plan.id, { stations: {} }, draft)
    expect(await store.read(plan.id)).toEqual(draft)
    expect((await rows(plan.id)).map((r) => `${r.part}:${r.key}`)).toEqual([
      "outline:",
      "station:a",
      "station:b",
    ])
  })

  it("writes only the pieces that changed", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    const first: PlanDraft = { outline, stations: { a: station("a") } }
    await store.save(plan.id, { stations: {} }, first)
    await env.DB.prepare(
      "UPDATE dispatch_drafts SET updated_at = 'earlier' WHERE plan_id = ?"
    )
      .bind(plan.id)
      .run()
    const next: PlanDraft = {
      ...first,
      stations: { ...first.stations, b: station("b") },
    }
    await store.save(plan.id, first, next)
    expect(
      (await rows(plan.id)).map((r) => [r.key, r.updated_at === "earlier"])
    ).toEqual([
      ["", true],
      ["a", true],
      ["b", false],
    ])
    // A replaced Station overwrites its own row.
    await store.save(plan.id, next, {
      ...next,
      stations: { ...next.stations, a: station("a", "Deliver a again") },
    })
    expect((await store.read(plan.id)).stations.a!.goal).toBe("Deliver a again")
  })

  it("clears a draft, and reads a row that no longer fits its schema as missing", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    await store.save(plan.id, { stations: {} }, { outline, stations: {} })
    await env.DB.prepare(
      "INSERT INTO dispatch_drafts (plan_id, part, key, body, updated_at) VALUES (?, 'station', 'a', ?, 'now')"
    )
      .bind(plan.id, JSON.stringify({ key: "a", name: "No manifest" }))
      .run()
    expect(await store.read(plan.id)).toEqual({ outline, stations: {} })
    await store.clear(plan.id)
    expect(await rows(plan.id)).toEqual([])
  })

  it("respects the Network deletion fence", async () => {
    const plan = await seedDispatchPlan()
    await env.DB.prepare("UPDATE networks SET deleting = 1 WHERE id = ?")
      .bind(plan.networkId)
      .run()
    await expect(
      new DispatchDraftStore(env.DB).save(
        plan.id,
        { stations: {} },
        { stations: { a: station("a") } }
      )
    ).rejects.toThrow("network_deleting")
  })
})
