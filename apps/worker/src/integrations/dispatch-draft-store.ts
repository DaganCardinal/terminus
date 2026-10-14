import {
  planOutlineSchema,
  planStationSchema,
  type PlanDraft,
} from "@terminus/protocol"

/**
 * The plan a Dispatcher session writes through its plan tools, one row per
 * piece. Parallel tool calls each write only their own piece, so they never
 * overwrite one another.
 */
export class DispatchDraftStore {
  private readonly db: D1Database
  constructor(db: D1Database) {
    this.db = db
  }

  /** Starts a session's draft from nothing. */
  async clear(planId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM dispatch_drafts WHERE plan_id = ?")
      .bind(planId)
      .run()
  }

  async read(planId: string): Promise<PlanDraft> {
    const { results } = await this.db
      .prepare(
        "SELECT part, key, body FROM dispatch_drafts WHERE plan_id = ? ORDER BY part, key"
      )
      .bind(planId)
      .all<{ part: string; key: string; body: string }>()
    const draft: PlanDraft = { stations: {} }
    // A row that no longer matches its schema reads as missing, so the agent
    // is asked for it again rather than the session failing.
    for (const row of results) {
      const body: unknown = JSON.parse(row.body)
      if (row.part === "outline") {
        const outline = planOutlineSchema.safeParse(body)
        if (outline.success) draft.outline = outline.data
      } else if (row.part === "station") {
        const station = planStationSchema.safeParse(body)
        if (station.success && station.data.key === row.key)
          draft.stations[row.key] = station.data
      }
    }
    return draft
  }

  /** Writes the pieces that differ between two drafts, in one batch. */
  async save(planId: string, before: PlanDraft, after: PlanDraft) {
    const at = new Date().toISOString()
    const upsert = (part: "outline" | "station", key: string, body: unknown) =>
      this.db
        .prepare(
          "INSERT INTO dispatch_drafts (plan_id, part, key, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(plan_id, part, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at"
        )
        .bind(planId, part, key, JSON.stringify(body), at)
    const writes = [
      ...(after.outline && after.outline !== before.outline
        ? [upsert("outline", "", after.outline)]
        : []),
      ...Object.entries(after.stations)
        .filter(
          ([key, station]) =>
            !Object.hasOwn(before.stations, key) ||
            before.stations[key] !== station
        )
        .map(([key, station]) => upsert("station", key, station)),
    ]
    if (writes.length) await this.db.batch(writes)
  }
}
