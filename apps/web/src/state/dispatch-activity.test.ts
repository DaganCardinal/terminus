import { describe, expect, it } from "vitest"
import type { AgentActivity, AgentActivityEntry } from "@terminus/protocol"
import {
  activityFailures,
  activityGroupSummary,
  activityLabel,
  groupDispatchActivity,
} from "./dispatch-activity"

const entry = (seq: number, activity: AgentActivity): AgentActivityEntry => ({
  seq,
  at: "2026-10-12T12:00:00.000Z",
  activity,
})

describe("Dispatcher activity groups", () => {
  it("groups related phases while retaining the order of separate exploration rounds", () => {
    const entries = [
      entry(1, { kind: "phase", phase: "preparing_workspace" }),
      entry(2, { kind: "phase", phase: "waiting_for_sandbox" }),
      entry(3, { kind: "phase", phase: "exploring" }),
      entry(4, {
        kind: "tool",
        tool: "read",
        status: "completed",
        path: "src/App.tsx",
      }),
      entry(5, { kind: "phase", phase: "validating_proposal" }),
      entry(6, { kind: "phase", phase: "correcting_proposal" }),
      entry(7, { kind: "phase", phase: "exploring" }),
      entry(8, { kind: "tool", tool: "search", status: "completed" }),
    ]
    const groups = groupDispatchActivity(entries)
    expect(groups.map((g) => g.label)).toEqual([
      "Workspace preparation",
      "Project exploration",
      "Writing and checking the plan",
      "Project exploration",
    ])
    expect(groups.map((g) => g.entries.map((e) => e.seq))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ])
    expect(groups.flatMap((g) => g.entries)).toEqual(entries)
    expect(
      groupDispatchActivity([
        ...entries,
        entry(9, { kind: "tool", tool: "read", status: "completed" }),
      ]).at(-1)?.id
    ).toBe(groups.at(-1)?.id)
  })

  it("counts completed observations separately from starts and failures", () => {
    const entries = [
      entry(1, { kind: "phase", phase: "exploring" }),
      entry(2, {
        kind: "tool",
        tool: "read",
        status: "running",
        path: "src/a.ts",
      }),
      entry(3, {
        kind: "tool",
        tool: "read",
        status: "completed",
        path: "src/a.ts",
      }),
      entry(4, {
        kind: "tool",
        tool: "read",
        status: "completed",
        path: "src/a.ts",
      }),
      entry(5, { kind: "tool", tool: "search", status: "completed" }),
      entry(6, { kind: "tool", tool: "explore", status: "failed" }),
    ]
    const group = groupDispatchActivity(entries)[0]!
    expect(activityGroupSummary(group)).toBe(
      "Completed 2 file reads · 1 search · 1 tool start reported · 1 tool failure reported"
    )
    expect(activityFailures(entries)).toBe(1)
    expect(activityLabel(entries[1]!.activity)).toBe("File read started")
    expect(activityLabel(entries[5]!.activity)).toBe(
      "Focused exploration failed"
    )
  })

  it("does not invent a phase or completion for a partial retained history", () => {
    const groups = groupDispatchActivity([
      entry(90, { kind: "tool", tool: "read", status: "running" }),
      entry(91, { kind: "phase", phase: "closing_workspace" }),
    ])
    expect(groups[0]!.label).toBe("Agent activity")
    expect(activityGroupSummary(groups[0]!)).toBe("1 tool start reported")
    expect(groups[1]!.label).toBe("Finishing up")
  })

  it("keeps simulation and preparation free of invented tool counts", () => {
    const groups = groupDispatchActivity([
      entry(1, { kind: "phase", phase: "simulation" }),
    ])
    expect(groups[0]!.label).toBe("Offline simulation")
    expect(activityGroupSummary(groups[0]!)).toBe("1 phase update")
    expect(groupDispatchActivity([])).toEqual([])
  })
})
