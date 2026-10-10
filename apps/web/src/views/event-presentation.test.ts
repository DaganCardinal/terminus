import { describe, expect, it } from "vitest"
import { OctagonAlert, Radio, TrainFront } from "lucide-react"
import { dayLabel, presentEvent } from "./event-presentation"

describe("presentEvent", () => {
  it("marks milestones, routine steps and failures", () => {
    expect(
      presentEvent({
        type: "car.attached",
        trainId: "t",
        stationId: "s",
        carId: "c",
        acceptedCommit: "abc",
      })
    ).toEqual({ icon: TrainFront, tone: "success" })
    expect(
      presentEvent({ type: "station.signaled", stationId: "s", trainId: "t" })
    ).toEqual({
      icon: Radio,
      tone: "info",
    })
    expect(
      presentEvent({
        type: "station.workspace_created",
        stationId: "s",
        repoId: "r",
        baseCommit: "abc",
      }).tone
    ).toBe("routine")
    expect(
      presentEvent({
        type: "train.blocked",
        trainId: "t",
        issues: [{ kind: "required_checks_failed", detail: "Tests failed" }],
      })
    ).toEqual({ icon: OctagonAlert, tone: "danger" })
  })
})

describe("dayLabel", () => {
  const now = new Date(2026, 9, 10, 9, 30)

  it("names today and yesterday by local calendar day", () => {
    expect(dayLabel(new Date(2026, 9, 10, 0, 1), now)).toBe("Today")
    expect(dayLabel(new Date(2026, 9, 9, 23, 59), now)).toBe("Yesterday")
  })

  it("shows older days as dates, with the year only when it differs", () => {
    expect(dayLabel(new Date(2026, 9, 7), now)).not.toMatch(/2026/)
    expect(dayLabel(new Date(2025, 11, 31), now)).toMatch(/2025/)
  })
})
