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
  it("retains draft pieces only while the trusted checkpoint matches", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    const draft = { outline, stations: { a: station("a") } }
    await store.begin(plan.id, "baseline-and-config-a", null)
    await store.save(plan.id, { stations: {} }, draft)
    await store.begin(plan.id, "baseline-and-config-a", null)
    expect(await store.restore(plan.id, "baseline-and-config-a")).toEqual({
      draft,
      baseline: null,
    })
    expect(await store.restore(plan.id, "different-context")).toBeNull()
    await store.begin(plan.id, "different-context", null)
    expect(await store.read(plan.id)).toEqual({ stations: {} })
    await store.clear(plan.id)
    expect(await store.restore(plan.id, "different-context")).toBeNull()
  })

  it("keeps a revision unfinished, with its draft, until its plan is accepted", async () => {
    const revised = await seedDispatchPlan()
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    const draft = { outline, stations: { a: station("a"), b: station("b") } }
    await store.save(revised.id, { stations: {} }, draft)
    await env.DB.batch(store.copyStatements(revised.id, plan.id))
    expect(await store.revising(plan.id)).toBe(true)
    expect(await store.restore(plan.id, "context")).toBeNull()
    // Preparation's checkpoint keeps the copied draft and the flag.
    await store.begin(plan.id, "context", null)
    expect(await store.restore(plan.id, "context")).toEqual({
      draft,
      baseline: null,
    })
    expect(await store.revising(plan.id)).toBe(true)
    // So does a changed context, while the revision is unfinished.
    await store.begin(plan.id, "other-context", null)
    expect(await store.read(plan.id)).toEqual(draft)
    await store.accept(plan.id)
    expect(await store.revising(plan.id)).toBe(false)
    expect(await store.revising(revised.id)).toBe(false)
    await store.begin(plan.id, "context", null)
    expect(await store.read(plan.id)).toEqual({ stations: {} })
  })

  it("treats corrupt checkpoint data as unavailable and corrupt pieces as missing", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    await store.begin(plan.id, "context", null)
    await store.save(
      plan.id,
      { stations: {} },
      { outline, stations: { a: station("a"), b: station("b") } }
    )
    await env.DB.prepare(
      "UPDATE dispatch_drafts SET body = '{' WHERE plan_id = ? AND key = 'a'"
    )
      .bind(plan.id)
      .run()
    expect((await store.restore(plan.id, "context"))!.draft).toEqual({
      outline,
      stations: { b: station("b") },
    })
    await env.DB.prepare(
      "UPDATE dispatch_draft_checkpoints SET baseline = '{' WHERE plan_id = ?"
    )
      .bind(plan.id)
      .run()
    expect(await store.restore(plan.id, "context")).toBeNull()
    await store.begin(plan.id, "context", null)
    expect(await store.read(plan.id)).toEqual({ stations: {} })
  })

  it("fences checkpoint creation during deletion and rolls back a reset when the fence rejects it", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    const draft = { stations: { a: station("a") } }
    await store.begin(plan.id, "context", null)
    await store.save(plan.id, { stations: {} }, draft)
    await env.DB.prepare("UPDATE networks SET deleting = 1 WHERE id = ?")
      .bind(plan.networkId)
      .run()
    await expect(store.begin(plan.id, "new-context", null)).rejects.toThrow(
      "network_deleting"
    )
    expect(await store.read(plan.id)).toEqual(draft)
    expect(await store.restore(plan.id, "context")).toEqual({
      draft,
      baseline: null,
    })
  })

  it("deletes checkpoints with their plan", async () => {
    const plan = await seedDispatchPlan()
    const store = new DispatchDraftStore(env.DB)
    await store.begin(plan.id, "context", null)
    await env.DB.prepare("DELETE FROM dispatch_plans WHERE id = ?")
      .bind(plan.id)
      .run()
    expect(await store.restore(plan.id, "context")).toBeNull()
  })

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
