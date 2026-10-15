import { describe, expect, it } from "vitest"
import { stressInterventions } from "./stress-report"

const unplaced =
  "Station run failed during checkout: There is no container instance that can be provided to this Durable Object, try again later"
const event = (type: string, trainId: string, detail?: string) => ({
  event: {
    type,
    trainId,
    ...(detail ? { issues: [{ kind: "station_failed", detail }] } : {}),
  },
})
const label = (trainId: string) => `Train ${trainId.slice(1)}`

describe("stress interventions", () => {
  it("names each Train whose Station failed, blocked or was cleared, once", () => {
    expect(
      stressInterventions(
        [
          event("train.departed", "t2"),
          event("station.run_failed", "t9", unplaced),
          event("station.blocked", "t9", unplaced),
          event("train.blocked", "t9", unplaced),
          event("station.run_failed", "t4", "Review crashed"),
          event("station.run_failed", "t4", "Review crashed"),
          event("train.blocked", "t4", "Review crashed"),
          event("train.cleared", "t9"),
          event("station.reset", "t9"),
          event("train.blocked", "t5", "Conductor review escalated"),
          event("train.cleared", "t4"),
          event("train.blocked", "t4", "Review crashed again"),
          event("train.cleared", "t4"),
        ],
        label
      )
    ).toEqual([
      `Train 9: Station run failed, blocked and cleared by intervention (${unplaced})`,
      "Train 4: 2 Station runs failed, blocked 2 times and cleared by intervention 2 times (Review crashed; Review crashed again)",
      "Train 5: blocked (Conductor review escalated)",
    ])
  })

  it("finds nothing in an uninterrupted run", () => {
    expect(
      stressInterventions(
        [
          event("train.departed", "t1"),
          event("station.ready_for_pickup", "t1"),
          event("train.unloaded", "t1"),
        ],
        label
      )
    ).toEqual([])
  })
})
