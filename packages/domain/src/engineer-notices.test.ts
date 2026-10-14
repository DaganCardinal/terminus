import { describe, expect, it } from "vitest"
import {
  engineerRecoveryNoticeEligible,
  acknowledgeEngineerNotice,
  resolveEngineerNotice,
  recordEngineerNotice,
  engineerNoticeCanAssess,
  engineerWaitMilestone,
} from "./engineer-notices"

describe("Engineer observation eligibility", () => {
  it.each([
    [0, null],
    [29.999, null],
    [30, 30],
    [59, 30],
    [60, 60],
    [119, 60],
    [120, 120],
    [239, 120],
    [240, 240],
    [360, 360],
  ])("assesses after %s minutes at milestone %s", (minutes, expected) => {
    expect(engineerWaitMilestone(minutes * 60_000)).toBe(expected)
  })
  it("reports backoff and repeated attempts, but leaves the first revision routine", () => {
    expect(
      engineerRecoveryNoticeEligible({ retriesUsed: 1, backoff: false })
    ).toBe(false)
    expect(
      engineerRecoveryNoticeEligible({ retriesUsed: 1, backoff: true })
    ).toBe(true)
    expect(
      engineerRecoveryNoticeEligible({ retriesUsed: 2, backoff: false })
    ).toBe(true)
  })
})

it("acknowledges and resolves an incident without losing lifecycle metadata", () => {
  const notice = {
    id: "n",
    trainId: "t",
    cause: "dependency" as const,
    fingerprint: "f",
    summary: "Wait",
    dependencyIds: ["s"],
    assessedAt: "now",
  }
  expect(recordEngineerNotice(undefined, notice).events).toHaveLength(1)
  const acknowledged = acknowledgeEngineerNotice(notice, "seen")
  expect(
    acknowledgeEngineerNotice(acknowledged.notice, "again").events
  ).toEqual([])
  expect(
    recordEngineerNotice(acknowledged.notice, {
      ...notice,
      summary: "Still waiting",
    }).notice
  ).toEqual(acknowledged.notice)
  const resolved = resolveEngineerNotice(acknowledged.notice, "done")
  expect(resolved.notice.acknowledgedAt).toBe("seen")
  expect(engineerNoticeCanAssess(resolved.notice)).toBe(false)
  expect(resolveEngineerNotice(resolved.notice, "again").events).toEqual([])
  expect(() =>
    recordEngineerNotice(notice, { ...notice, id: "different" })
  ).toThrow()
})
