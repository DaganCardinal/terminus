import { describe, expect, it } from "vitest"
import { stressTimings, latencySummary, phaseTimings } from "./report.ts"

const event = (seconds: number, type: string, trainId = "a") => ({
  occurredAt: new Date(seconds * 1000).toISOString(),
  event: { type, trainId },
})
describe("stress report", () => {
  it("groups relevant phase and capacity timings while excluding unrelated work", () => {
    const records = [
      {
        message:
          '[perf] station.run.done {"stationId":"s1","phases":{"checkout":100,"dependencies":200}}',
      },
      {
        message:
          '[perf] station.run.done {"stationId":"other","phases":{"checkout":999}}',
      },
      {
        message:
          '[perf] sandbox.lease {"sandbox":"station-s1-s1-r0","waitedMs":50}',
      },
    ]
    expect(
      phaseTimings(records, { stations: [{ id: "s1" }], trains: [], cars: [] })
    ).toMatchObject({
      "station.run.done:checkout": { totalMs: 100, requests: 1 },
      "station.run.done:dependencies": { totalMs: 200 },
      "sandbox.capacity_wait": { totalMs: 50 },
    })
  })
  it("separates work, queue wait and integration service time, including a backlog", () => {
    const report = stressTimings([
      event(0, "train.departed"),
      event(2, "train.departed", "b"),
      event(10, "terminus.integration_requested"),
      event(11, "terminus.integration_requested", "b"),
      event(12, "terminus.clearance_granted"),
      event(20, "terminus.promoted"),
      event(21, "terminus.clearance_granted", "b"),
      event(30, "terminus.promoted", "b"),
    ])
    expect(report).toMatchObject({
      maxQueueDepth: 2,
      drainMs: 20_000,
      integrationsPerMinute: 6,
      findings: [],
    })
    expect(report.trains).toEqual([
      expect.objectContaining({
        workMs: 10_000,
        queueMs: 2000,
        integrationMs: 8000,
      }),
      expect.objectContaining({
        workMs: 9000,
        queueMs: 10_000,
        integrationMs: 9000,
      }),
    ])
  })
  it("detects overlapping reservations and promotions without clearance", () => {
    expect(
      stressTimings([
        event(1, "terminus.clearance_granted"),
        event(2, "terminus.clearance_granted", "b"),
      ]).findings
    ).toHaveLength(1)
    expect(
      stressTimings([event(1, "terminus.promoted")]).findings
    ).toHaveLength(1)
  })
  it("keeps missing data null and includes request failures in latency statistics", () => {
    expect(stressTimings([]).drainMs).toBeNull()
    expect(
      latencySummary([
        { ms: 10, ok: true },
        { ms: 40, ok: false },
      ])
    ).toEqual({ requests: 2, errors: 1, p50Ms: 10, p95Ms: 40, maxMs: 40 })
  })
})
