import { describe, expect, it } from "vitest"
import { layLineRequestSchema, type NetworkSnapshot } from "./api"
import {
  stressFiles,
  stressLines,
  stressReportPending,
  stressTask,
} from "./stress-test"

const runId = "00000000-0000-4000-8000-000000000001"
describe("versioned ten-Train fixture", () => {
  it("creates ten distinct, bounded manifests accepted by the normal Line API", () => {
    const lines = stressLines(runId)
    expect(lines).toHaveLength(10)
    const paths = new Set<string>()
    for (const line of lines) {
      expect(layLineRequestSchema.parse(line)).toEqual(line)
      const task = stressTask(line.stations[0]!.manifest)
      for (const path of Object.keys(stressFiles(task))) paths.add(path)
      expect(task.runId).toBe(runId)
    }
    expect(paths.size).toBe(20)
  })
  it("refuses altered manifests and unsafe run identities", () => {
    const manifest = stressLines(runId)[0]!.stations[0]!.manifest
    expect(() =>
      stressTask({ ...manifest, expectedAreas: ["package.json"] })
    ).toThrow("differs")
    expect(() => stressTask({ ...manifest, expectedEvidence: [] })).toThrow(
      "differs"
    )
    expect(() => stressFiles({ runId: "../../secrets", train: 1 })).toThrow()
    expect(() => stressFiles({ runId, train: 11 })).toThrow()
  })
  it("waits until every Train stops and capacity drains, ignoring expired lease rows", () => {
    const trains = (...statuses: string[]) => ({
      trains: statuses.map((status) => ({
        train: { state: { status } },
      })) as unknown as NetworkSnapshot["trains"],
    })
    const idle = { leases: 0, expiredLeases: 3, activeIntegrations: 0 }
    expect(stressReportPending(trains("unloaded", "in_transit"), idle)).toBe(
      "1 Train is still running"
    )
    expect(
      stressReportPending(trains("unloaded", "blocked", "siding"), idle)
    ).toBeNull()
    expect(
      stressReportPending(trains("unloaded"), {
        ...idle,
        activeIntegrations: 1,
      })
    ).toBe("An integration into Terminus is still active")
    expect(
      stressReportPending(trains("unloaded"), { ...idle, leases: 2 })
    ).toBe("2 Sandboxes are still running")
  })
})
