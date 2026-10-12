import {
  agentActivitySchema,
  dispatchActivityResponseSchema,
  type AgentActivity,
  type ActivityObserver,
  type DispatchActivityResponse,
} from "@terminus/protocol"

const historyLimit = 200
type PendingActivity = { position: number; at: string; activity: AgentActivity }

export class DispatchActivityStore {
  private readonly db: D1Database
  constructor(db: D1Database) {
    this.db = db
  }

  async begin(planId: string): Promise<DispatchActivityRecorder> {
    const attempt = crypto.randomUUID()
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO dispatch_activity_runs (plan_id, attempt) VALUES (?, ?) ON CONFLICT(plan_id) DO UPDATE SET attempt = excluded.attempt"
        )
        .bind(planId, attempt),
      this.db
        .prepare("DELETE FROM dispatch_activity WHERE plan_id = ?")
        .bind(planId),
    ])
    return new DispatchActivityRecorder(this, planId, attempt)
  }

  async append(planId: string, attempt: string, entries: PendingActivity[]) {
    if (!entries.length) return
    await this.db.batch([
      ...entries.map(({ position, at, activity }) =>
        this.db
          .prepare(
            "INSERT OR IGNORE INTO dispatch_activity (plan_id, attempt, position, at, activity) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dispatch_activity_runs WHERE plan_id = ? AND attempt = ?)"
          )
          .bind(
            planId,
            attempt,
            position,
            at,
            JSON.stringify(agentActivitySchema.parse(activity)),
            planId,
            attempt
          )
      ),
      this.db
        .prepare(
          "DELETE FROM dispatch_activity WHERE plan_id = ? AND seq NOT IN (SELECT seq FROM dispatch_activity WHERE plan_id = ? ORDER BY seq DESC LIMIT ?) AND seq <> COALESCE((SELECT MAX(seq) FROM dispatch_activity WHERE plan_id = ? AND json_extract(activity, '$.kind') = 'phase'), -1)"
        )
        .bind(planId, planId, historyLimit - 1, planId),
    ])
  }

  async read(planId: string, after: number): Promise<DispatchActivityResponse> {
    // A single batch gives the attempt and its entries one consistent snapshot.
    const [run, rows] = await this.db.batch<Record<string, unknown>>([
      this.db
        .prepare("SELECT attempt FROM dispatch_activity_runs WHERE plan_id = ?")
        .bind(planId),
      this.db
        .prepare(
          "SELECT seq, at, activity FROM dispatch_activity WHERE plan_id = ? AND seq > ? ORDER BY seq LIMIT 101"
        )
        .bind(planId, after),
    ])
    const entries = rows!.results.slice(0, 100).map((row) => ({
      seq: row.seq,
      at: row.at,
      activity: JSON.parse(row.activity as string) as unknown,
    }))
    return dispatchActivityResponseSchema.parse({
      attempt: run!.results[0]?.attempt ?? null,
      entries,
      lastSeq: entries.at(-1)?.seq ?? after,
      hasMore: rows!.results.length > 100,
    })
  }
}

/** Batches observations without making model execution wait for D1 writes. */
export class DispatchActivityRecorder {
  private position = 0
  private queue: PendingActivity[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> = Promise.resolve()
  private flushing = false
  private closed = false
  private readonly store: DispatchActivityStore
  private readonly planId: string
  readonly attempt: string
  constructor(store: DispatchActivityStore, planId: string, attempt: string) {
    this.store = store
    this.planId = planId
    this.attempt = attempt
  }

  readonly observe: ActivityObserver = (activity) => {
    if (this.closed) return
    const parsed = agentActivitySchema.safeParse(activity)
    if (!parsed.success) return
    // A broken/noisy harness cannot create an unbounded in-memory backlog.
    if (this.queue.length >= 50) {
      const tool = this.queue.findIndex(
        (entry) => entry.activity.kind === "tool"
      )
      this.queue.splice(tool === -1 ? 0 : tool, 1)
    }
    this.queue.push({
      position: ++this.position,
      at: new Date().toISOString(),
      activity: parsed.data,
    })
    if (!this.flushing) this.schedule()
  }

  private schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 1000)
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.writing
    const entries = this.queue.splice(0)
    if (!entries.length) return this.writing
    this.flushing = true
    this.writing = (async () => {
      try {
        await this.store.append(this.planId, this.attempt, entries)
      } catch {
        console.warn("Dispatcher activity persistence unavailable")
      } finally {
        this.flushing = false
        if (!this.closed && this.queue.length) this.schedule()
      }
    })()
    return this.writing
  }

  async close() {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.flush()
    await this.flush()
  }
}
