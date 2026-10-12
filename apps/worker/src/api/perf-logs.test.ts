import type { PerfLogRecord } from "@terminus/protocol"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { handleApi } from "./router"
import type { PerfLogsResponse } from "./perf-logs"

function record(t: string, invocation: string, message: string): PerfLogRecord {
  return {
    t,
    entrypoint: "TrainWorkflow",
    invocation,
    outcome: "ok",
    truncated: false,
    message,
  }
}

async function store(key: string, records: PerfLogRecord[]) {
  await env.PERF_LOGS.put(key, JSON.stringify(records))
}

describe("GET /api/perf-logs", () => {
  it("returns a window's lines across hours, oldest first", async () => {
    await store("perf/2026-10-12T15/a.json", [
      record("2026-10-12T15:58:00.000Z", "a", "[perf] early"),
      record("2026-10-12T15:59:30.000Z", "a", "[perf] three"),
    ])
    await store("perf/2026-10-12T16/a.json", [
      record("2026-10-12T16:00:10.000Z", "a", "[perf] four"),
    ])
    await store("perf/2026-10-12T15/b.json", [
      record("2026-10-12T15:59:00.000Z", "b", "[perf] two"),
    ])
    await store("perf/2026-10-12T17/c.json", [
      record("2026-10-12T17:00:00.000Z", "c", "[perf] late"),
    ])

    const response = await handleApi(
      new Request(
        "https://terminus.test/api/perf-logs?from=2026-10-12T15:58:30Z&to=2026-10-12T16:30:00Z"
      ),
      env
    )
    expect(response.status).toBe(200)
    const body = await response.json<PerfLogsResponse>()
    expect(body.records.map((line) => line.message)).toEqual([
      "[perf] two",
      "[perf] three",
      "[perf] four",
    ])
    expect(body).toMatchObject({
      from: "2026-10-12T15:58:30.000Z",
      to: "2026-10-12T16:30:00.000Z",
      invocations: 2,
      complete: true,
    })
  })

  it("refuses an unreadable or overlong window", async () => {
    for (const query of [
      "from=yesterday",
      "from=2026-10-12T16:00:00Z&to=2026-10-12T15:00:00Z",
      "from=2026-10-12T08:00:00Z&to=2026-10-12T15:00:00Z",
    ]) {
      const response = await handleApi(
        new Request(`https://terminus.test/api/perf-logs?${query}`),
        env
      )
      expect(response.status).toBe(400)
    }
  })
})
