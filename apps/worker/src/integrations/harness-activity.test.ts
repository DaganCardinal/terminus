import { describe, expect, it } from "vitest"
import type { AgentActivity } from "@terminus/protocol"
import { consumeHarnessActivity } from "./harness"

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}
describe("live harness activity transport", () => {
  it("handles split records, rejects unknown fields and does not let observer failures affect the result", async () => {
    const activities: AgentActivity[] = []
    const exit = await consumeHarnessActivity(
      stream([
        '{"type":"activity","activity":{"kind":"tool","tool":"read",',
        '"status":"completed","path":"src/a.ts"}}\n',
        '{"type":"activity","activity":{"kind":"tool","tool":"read","status":"completed","output":"PRIVATE"}}\n',
        '{"type":"harness_exit","exitCode":0}',
      ]),
      (activity) => {
        activities.push(activity)
        throw new Error("Observer failed")
      }
    )
    expect(exit).toEqual({ exitCode: 0 })
    expect(activities).toEqual([
      { kind: "tool", tool: "read", status: "completed", path: "src/a.ts" },
    ])
  })
  it("requires process completion and retains nonzero exit codes", async () => {
    await expect(consumeHarnessActivity(stream([]), () => {})).rejects.toThrow(
      "without an outcome"
    )
    expect(
      await consumeHarnessActivity(
        stream(['{"type":"harness_exit","exitCode":1}\n']),
        () => {}
      )
    ).toEqual({ exitCode: 1 })
  })
  it("hands each model step to the timeline as it arrives, never to the observer", async () => {
    const activities: AgentActivity[] = []
    const steps: Record<string, unknown>[] = []
    const step = JSON.stringify({
      type: "perf_step",
      step: 1,
      notes: [{ excerpt: "x".repeat(20_000) }],
    })
    const exit = await consumeHarnessActivity(
      stream([
        step.slice(0, 10_000),
        `${step.slice(10_000)}\n`,
        '{"type":"harness_exit","exitCode":0,"stopped":"proposal_rejected"}\n',
      ]),
      (activity) => activities.push(activity),
      (value) => steps.push(value)
    )
    expect(exit).toEqual({ exitCode: 0, stopped: "proposal_rejected" })
    expect(activities).toEqual([])
    expect(steps).toEqual([
      expect.objectContaining({ step: 1, type: undefined }),
    ])
  })
  it("carries an early stop and abnormal-exit diagnosis, but no unknown fields", async () => {
    expect(
      await consumeHarnessActivity(
        stream([
          '{"type":"harness_exit","exitCode":0,"stopped":"proposal_stalled","arguments":"PRIVATE"}\n',
        ]),
        () => {}
      )
    ).toEqual({ exitCode: 0, stopped: "proposal_stalled" })
    expect(
      await consumeHarnessActivity(
        stream([
          '{"type":"harness_exit","exitCode":0,"stopped":"proposal_accepted","extra":"PRIVATE"}\n',
        ]),
        () => {}
      )
    ).toEqual({ exitCode: 0, stopped: "proposal_accepted" })
    expect(
      await consumeHarnessActivity(
        stream([
          JSON.stringify({
            type: "harness_exit",
            exitCode: 143,
            signal: "SIGTERM",
            stderrTail: "x".repeat(900) + "\u0007fatal",
            stopped: "other",
          }),
        ]),
        () => {}
      )
    ).toEqual({
      exitCode: 143,
      signal: "SIGTERM",
      stderrTail: "x".repeat(795) + "fatal",
    })
  })
})
