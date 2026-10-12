import {
  PERF_LOG_PREFIX,
  perfLogHour,
  type PerfLogRecord,
} from "@terminus/protocol"

/** The parts of a tailed invocation (`TraceItem`) this Worker reads. */
export interface TailedInvocation {
  readonly entrypoint?: string
  readonly scriptName: string | null
  readonly eventTimestamp: number | null
  readonly outcome: string
  readonly truncated: boolean
  readonly logs: readonly { timestamp: number; message: unknown }[]
  readonly exceptions: readonly { name: string }[]
}

/**
 * The R2 objects to write for a batch of tailed invocations: each one's
 * `[perf]` lines, keyed `perf/<UTC hour>/<invocation>.json`. An invocation
 * whose lines span hours is stored once per hour.
 *
 * An invocation that ended badly or had its logs cut short also gets a
 * `[perf-tail] invocation` line, even with no `[perf]` lines of its own,
 * because a lost or killed invocation is what this sink exists to show.
 * Only exception names are kept: messages can carry credentials.
 */
export function perfObjects(
  invocations: readonly TailedInvocation[],
  newId: () => string
): Map<string, PerfLogRecord[]> {
  const objects = new Map<string, PerfLogRecord[]>()
  for (const item of invocations) {
    const started = item.eventTimestamp ?? item.logs[0]?.timestamp ?? Date.now()
    const invocation = `${new Date(started).toISOString()}-${newId()}`
    const base = {
      entrypoint: item.entrypoint ?? item.scriptName ?? "unknown",
      invocation,
      outcome: item.outcome,
      truncated: item.truncated,
    }
    const records: PerfLogRecord[] = item.logs.flatMap((log) => {
      const message = perfLine(log.message)
      return message
        ? [{ t: new Date(log.timestamp).toISOString(), ...base, message }]
        : []
    })
    if (item.outcome !== "ok" || item.truncated)
      records.push({
        t: new Date(started).toISOString(),
        ...base,
        message: `[perf-tail] invocation ${JSON.stringify({
          outcome: item.outcome,
          truncated: item.truncated,
          exceptions: item.exceptions.map((exception) => exception.name),
        })}`,
      })
    for (const record of records) {
      const key = `${PERF_LOG_PREFIX}${perfLogHour(record.t)}/${invocation}.json`
      const object = objects.get(key)
      if (object) object.push(record)
      else objects.set(key, [record])
    }
  }
  return objects
}

/** `perf()` logs one string argument, so a tailed log's message is `[line]`. */
function perfLine(message: unknown): string | null {
  const line = Array.isArray(message) ? message[0] : message
  return typeof line === "string" && line.startsWith("[perf] ") ? line : null
}
