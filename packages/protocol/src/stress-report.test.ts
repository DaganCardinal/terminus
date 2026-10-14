import { describe, expect, it } from "vitest"
import { stressInterventions, stressPlacementRetries } from "./stress-report"

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

const retry = (sandbox: string, pauseMs: number, binding = "SANDBOX") => ({
  message: `[perf] sandbox.placement_retry ${JSON.stringify({
    t: "2026-10-14T18:20:00.000Z",
    sandbox,
    binding,
    attempt: 1,
    pauseMs,
  })}`,
})

describe("stress placement retries", () => {
  it("warns once per Sandbox of this run, in order of its first retry", () => {
    expect(
      stressPlacementRetries(
        [
          { message: '[perf] sandbox.setup {"sandbox":"station-s6-s1-r0"}' },
          retry("station-s6-s1-r0", 5_000),
          retry("git-a", 5_000, "WORKSPACE_SANDBOX"),
          retry("station-other-s1-r0", 5_000),
          retry("station-s6-s1-r0", 10_000),
          { message: "[perf] sandbox.placement_retry {not json}" },
          { message: '[perf] sandbox.placement_retry {"sandbox":"git-b"}' },
          retry("station-s6-s1-r0", 20_000),
        ],
        (sandbox) => !sandbox.startsWith("station-other-"),
        (sandbox) => `Sandbox ${sandbox}`
      )
    ).toEqual([
      "Sandbox station-s6-s1-r0: Cloudflare could not place its container 3 times and retried after 35 s of pauses",
      "Sandbox git-a: Cloudflare could not place its container once and retried after 5 s of pauses",
    ])
  })

  it("passes each record's binding to the run check", () => {
    const seen: string[] = []
    stressPlacementRetries(
      [retry("git-a", 5_000, "WORKSPACE_SANDBOX")],
      (sandbox, binding) => {
        seen.push(`${binding}/${sandbox}`)
        return false
      },
      String
    )
    expect(seen).toEqual(["WORKSPACE_SANDBOX/git-a"])
  })
})
