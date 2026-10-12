import { describe, expect, it } from "vitest"
import type { AgentActivityEntry } from "@terminus/protocol"
import { mergeDispatchActivity } from "./use-dispatch-activity"

const entry = (seq: number): AgentActivityEntry => ({
  seq,
  at: "2026-10-12T12:00:00.000Z",
  activity: { kind: "tool", tool: "read", status: "completed" },
})
describe("Dispatcher activity projection", () => {
  it("deduplicates pages and resets when a new execution attempt begins", () => {
    const feed = { attempt: "old", entries: [entry(1)], lastSeq: 1 }
    expect(
      mergeDispatchActivity(feed, {
        attempt: "old",
        entries: [entry(1), entry(2)],
        lastSeq: 2,
        hasMore: false,
      }).entries.map((e) => e.seq)
    ).toEqual([1, 2])
    expect(
      mergeDispatchActivity(feed, {
        attempt: "new",
        entries: [entry(3)],
        lastSeq: 3,
        hasMore: false,
      }).entries.map((e) => e.seq)
    ).toEqual([3])
  })
  it("retains the current phase when tool history reaches its limit", () => {
    const phase: AgentActivityEntry = {
      ...entry(1),
      activity: { kind: "phase", phase: "exploring" },
    }
    const result = mergeDispatchActivity(
      {
        attempt: "a",
        entries: [
          phase,
          ...Array.from({ length: 199 }, (_, i) => entry(i + 2)),
        ],
        lastSeq: 200,
      },
      { attempt: "a", entries: [entry(201)], lastSeq: 201, hasMore: false }
    )
    expect(result.entries).toHaveLength(200)
    expect(result.entries[0]).toEqual(phase)
    expect(result.entries.at(-1)?.seq).toBe(201)
  })
})
