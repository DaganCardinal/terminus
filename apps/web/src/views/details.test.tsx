import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { Issue, NetworkSnapshot, Train } from "@terminus/protocol"
import { BlockedAction } from "./details"

const train = (issues: Issue[]) =>
  ({
    id: "t",
    lineId: "l",
    headCommit: "b".repeat(40),
    state: { status: "blocked", issues },
  }) as unknown as Train

const conflict = {
  id: "c",
  trainIds: ["t"],
  paths: ["src/App.tsx"],
  description: "Merge conflict",
  status: "open",
}

function render(
  value: Train,
  {
    conflicts = [],
    repairs = [],
  }: { conflicts?: unknown[]; repairs?: unknown[] } = {}
) {
  const snapshot = {
    network: { id: "n", name: "Demo", terminusCommit: "a".repeat(40) },
    trains: [{ train: value }],
    conflicts,
    repairs,
  } as unknown as NetworkSnapshot
  return renderToStaticMarkup(
    <BlockedAction
      snapshot={snapshot}
      train={value}
      pending={false}
      run={async () => {}}
    />
  )
}

const repair = (status: string) => ({
  id: "r",
  conflictId: "c",
  source: {
    trainId: "t",
    trainCommit: "b".repeat(40),
    terminusCommit: "a".repeat(40),
  },
  state: { status },
})

describe("Blocked Train action", () => {
  const merge = train([{ kind: "integration_failed", detail: "Conflict" }])

  it("offers a Technician, not a clear, for an open conflict at Terminus", () => {
    const html = render(merge, { conflicts: [conflict] })
    expect(html).toContain("Dispatch Technician")
    expect(html).not.toContain("Clear block")
  })

  it("points at the repair while a Technician is working on it", () => {
    const html = render(merge, {
      conflicts: [conflict],
      repairs: [repair("running")],
    })
    expect(html).toContain("A Technician is repairing the conflict")
    expect(html).not.toContain("<button")
  })

  it("offers a fresh Technician after a repair stopped", () => {
    const html = render(merge, {
      conflicts: [conflict],
      repairs: [repair("failed")],
    })
    expect(html).toContain("Dispatch a fresh Technician")
  })

  it("ignores a resolved conflict", () => {
    const html = render(merge, {
      conflicts: [{ ...conflict, status: "resolved" }],
    })
    expect(html).toContain("Clear block")
  })

  it("retries a Station that used up its revisions", () => {
    for (const kind of [
      "station_retries_exhausted",
      "engineer_escalated",
    ] as const) {
      const html = render(train([{ kind, detail: "Stopped" }]))
      expect(html).toContain("Retry Station")
      expect(html).not.toContain("Clear block")
    }
  })

  it("clears any other block", () => {
    const html = render(train([{ kind: "station_failed", detail: "Broken" }]))
    expect(html).toContain("Clear block")
  })
})
