import {
  PERF_LOG_PREFIX,
  perfLogHour,
  type PerfLogRecord,
} from "@terminus/protocol"

/*
 * TEMPORARY benchmark instrumentation, removed with apps/perf-tail and
 * packages/protocol/src/perf-log.ts.
 */

const HOUR_MS = 3_600_000
const MAX_WINDOW_MS = 6 * HOUR_MS
/** Each object is one read, and a request may make only so many. */
const MAX_OBJECTS = 800
const READ_CONCURRENCY = 16

export interface PerfLogsResponse {
  from: string
  to: string
  /** Distinct invocations among `records`. */
  invocations: number
  /** False when the window held more objects than one request reads. */
  complete: boolean
  records: PerfLogRecord[]
}

/**
 * `GET /api/perf-logs?from=<ISO>&to=<ISO>`: every `[perf]` line the perf
 * Tail Worker stored for that window, oldest first. `to` defaults to now and
 * `from` to an hour before `to`; a window may span at most six hours.
 */
export async function readPerfLogs(
  bucket: R2Bucket,
  query: URLSearchParams,
  now = Date.now()
): Promise<PerfLogsResponse | { error: string }> {
  const to = query.has("to") ? Date.parse(query.get("to")!) : now
  const from = query.has("from") ? Date.parse(query.get("from")!) : to - HOUR_MS
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
    return { error: "`from` and `to` must be ISO times, `from` first" }
  if (to - from > MAX_WINDOW_MS)
    return { error: "A window may span at most six hours" }

  const keys: string[] = []
  const firstHour = Math.floor(from / HOUR_MS) * HOUR_MS
  for (let hour = firstHour; hour <= to; hour += HOUR_MS) {
    let cursor: string | undefined
    do {
      const page = await bucket.list({
        prefix: `${PERF_LOG_PREFIX}${perfLogHour(hour)}/`,
        ...(cursor ? { cursor } : {}),
      })
      keys.push(...page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }

  const read = keys.slice(0, MAX_OBJECTS)
  const records: PerfLogRecord[] = []
  for (let i = 0; i < read.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(
      read.slice(i, i + READ_CONCURRENCY).map(async (key) => {
        const object = await bucket.get(key)
        return object ? await object.json<PerfLogRecord[]>() : []
      })
    )
    for (const record of batch.flat()) {
      const t = Date.parse(record.t)
      if (t >= from && t <= to) records.push(record)
    }
  }
  records.sort((a, b) => a.t.localeCompare(b.t))
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    invocations: new Set(records.map((record) => record.invocation)).size,
    complete: read.length === keys.length,
    records,
  }
}
