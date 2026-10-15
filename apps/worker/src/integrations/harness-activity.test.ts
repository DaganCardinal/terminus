import { describe, expect, it, vi } from "vitest"
import type { AgentActivity } from "@terminus/protocol"
import { consumeHarnessActivity } from "./harness"

const encoder = new TextEncoder()
/** Sends `chunks`, then fails as a lost Sandbox stream does. */
function dropped(chunks: string[], lost: Error) {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length)
        controller.enqueue(encoder.encode(chunks[sent++]))
      else controller.error(lost)
    },
  })
}
const read = (path: string) =>
  `${JSON.stringify({ type: "activity", activity: { kind: "tool", tool: "read", status: "completed", path } })}\n`

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
  it("carries a timeout the runner enforced itself", async () => {
    expect(
      await consumeHarnessActivity(
        stream([
          '{"type":"harness_exit","exitCode":143,"signal":"SIGTERM","timedOut":true}\n',
        ]),
        () => {}
      )
    ).toEqual({ exitCode: 143, signal: "SIGTERM", timedOut: true })
  })
})

describe("live harness stream loss", () => {
  const lost = new Error("Network connection lost.")

  it("follows the still-running harness again after the lines already handled, observing each once", async () => {
    const paths: string[] = []
    const reattach = vi.fn(async () =>
      stream([
        read("src/c.ts"),
        read("src/d.ts"),
        '{"type":"harness_exit","exitCode":0,"stopped":"proposal_accepted"}\n',
      ])
    )
    const exit = await consumeHarnessActivity(
      // Lost partway through the third line, which is read again in full.
      dropped(
        [read("src/a.ts") + read("src/b.ts") + read("src/c.ts").slice(0, 30)],
        lost
      ),
      (activity) => {
        if (activity.kind === "tool" && activity.path) paths.push(activity.path)
      },
      reattach
    )
    expect(reattach).toHaveBeenCalledExactlyOnceWith(2, lost)
    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
    expect(exit).toEqual({ exitCode: 0, stopped: "proposal_accepted" })
  })

  it("follows again each time the stream is lost, counting every line handled", async () => {
    const reattach = vi
      .fn<
        (lines: number, lost: unknown) => Promise<ReadableStream<Uint8Array>>
      >()
      .mockResolvedValueOnce(dropped([read("src/b.ts")], lost))
      .mockResolvedValueOnce(stream(['{"type":"harness_exit","exitCode":0}\n']))
    expect(
      await consumeHarnessActivity(
        dropped([read("src/a.ts")], lost),
        () => {},
        reattach
      )
    ).toEqual({ exitCode: 0 })
    expect(reattach.mock.calls.map(([lines]) => lines)).toEqual([1, 2])
  })

  it("fails with what lost the stream when the harness cannot be followed again", async () => {
    await expect(
      consumeHarnessActivity(dropped([read("src/a.ts")], lost), () => {})
    ).rejects.toBe(lost)
    await expect(
      consumeHarnessActivity(
        dropped([read("src/a.ts")], lost),
        () => {},
        async () => null
      )
    ).rejects.toBe(lost)
  })

  it("keeps an outcome that arrived before the stream was lost", async () => {
    expect(
      await consumeHarnessActivity(
        dropped(['{"type":"harness_exit","exitCode":0}\n'], lost),
        () => {},
        async () => null
      )
    ).toEqual({ exitCode: 0 })
  })

  it("never follows a malformed stream again", async () => {
    const reattach = vi.fn(async () => stream([]))
    await expect(
      consumeHarnessActivity(stream(["x".repeat(70_000)]), () => {}, reattach)
    ).rejects.toThrow("Invalid activity stream")
    expect(reattach).not.toHaveBeenCalled()
  })
})
