import { describe, expect, it } from "vitest"
import { perfObjects, type TailedInvocation } from "./records"

function invocation(
  overrides: Partial<TailedInvocation> = {}
): TailedInvocation {
  return {
    entrypoint: "TrainWorkflow",
    scriptName: "terminus",
    eventTimestamp: Date.parse("2026-10-12T15:34:30.000Z"),
    outcome: "ok",
    truncated: false,
    logs: [],
    exceptions: [],
    ...overrides,
  }
}

const at = (time: string) => Date.parse(`2026-10-12T${time}Z`)

describe("perf Tail Worker records", () => {
  it("keeps only [perf] lines, grouped by invocation and the hour they were logged", () => {
    let serial = 0
    const objects = perfObjects(
      [
        invocation({
          logs: [
            { timestamp: at("15:34:30.641"), message: ["[perf] a {}"] },
            { timestamp: at("15:40:00.000"), message: ["other output"] },
            { timestamp: at("16:00:01.000"), message: ["[perf] b {}"] },
          ],
        }),
        invocation({ entrypoint: undefined, logs: [] }),
      ],
      () => `id${++serial}`
    )
    const id = "2026-10-12T15:34:30.000Z-id1"
    expect([...objects.keys()]).toEqual([
      `perf/2026-10-12T15/${id}.json`,
      `perf/2026-10-12T16/${id}.json`,
    ])
    expect(objects.get(`perf/2026-10-12T15/${id}.json`)).toEqual([
      {
        t: "2026-10-12T15:34:30.641Z",
        entrypoint: "TrainWorkflow",
        invocation: id,
        outcome: "ok",
        truncated: false,
        message: "[perf] a {}",
      },
    ])
    expect(objects.get(`perf/2026-10-12T16/${id}.json`)![0]!.message).toBe(
      "[perf] b {}"
    )
  })

  it("records an invocation that ended badly or was cut short, with exception names only", () => {
    const objects = perfObjects(
      [
        invocation({
          entrypoint: undefined,
          outcome: "exceededMemory",
          exceptions: [{ name: "Error" }],
        }),
        invocation({ truncated: true }),
      ],
      () => "x"
    )
    expect(
      [...objects.values()].flat().map(({ entrypoint, message }) => ({
        entrypoint,
        message,
      }))
    ).toEqual([
      {
        entrypoint: "terminus",
        message:
          '[perf-tail] invocation {"outcome":"exceededMemory","truncated":false,"exceptions":["Error"]}',
      },
      {
        entrypoint: "TrainWorkflow",
        message:
          '[perf-tail] invocation {"outcome":"ok","truncated":true,"exceptions":[]}',
      },
    ])
  })
})
