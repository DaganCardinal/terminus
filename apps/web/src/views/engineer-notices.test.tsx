import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { NetworkSnapshot } from "@terminus/protocol"
import { AttentionMessages } from "./dispatcher-alerts"
import { dispatcherIndicator } from "./dispatcher-state"

function snapshot(blocked = false): NetworkSnapshot {
  return {
    network: { id: "n", name: "Demo", createdAt: "2026-10-13T00:00:00Z" },
    lines: [{ id: "l", name: "Receiver", stationIds: ["s"] }],
    trains: [
      {
        train: {
          id: "t",
          lineId: "l",
          state: blocked
            ? {
                status: "blocked",
                issues: [{ kind: "station_failed", detail: "Broken setup" }],
              }
            : {
                status: "held",
                reasons: [{ kind: "dependency", stationId: "s" }],
              },
        },
        stateEnteredAt: "2026-10-13T00:00:00Z",
      },
    ],
    stations: [{ id: "s", lineId: "l", name: "Upstream" }],
    cars: [],
    holds: [],
    conflicts: [],
    plans: [],
    engineerNotices: [
      {
        id: "notice",
        trainId: "t",
        stationId: "s",
        cause: "dependency",
        fingerprint: "f",
        summary: "Waiting for upstream work for 30 minutes.",
        dependencyIds: ["s"],
        assessedAt: "2026-10-13T00:30:00Z",
      },
    ],
  } as unknown as NetworkSnapshot
}
function render(value: NetworkSnapshot) {
  return renderToStaticMarkup(
    <AttentionMessages
      snapshot={value}
      pending={false}
      command={async (run) => {
        await run()
      }}
      openTrain={() => {}}
    />
  )
}
describe("Engineer Dispatcher cards", () => {
  it("rebuilds the same advisory card from a refreshed snapshot", () => {
    const value = snapshot()
    const html = render(value)
    expect(html).toContain("Engineer concern")
    expect(html).toContain("30 minutes")
    expect(html).toContain("Acknowledge")
    expect(html).toContain("Open Upstream")
    expect(render(JSON.parse(JSON.stringify(value)))).toBe(html)
    expect(dispatcherIndicator(value).tone).toBe("attention")
  })
  it("merges an overlapping advisory into the required blocker card", () => {
    const value = snapshot(true)
    const html = render(value)
    expect(html).toContain("Broken setup")
    expect(html).toContain("Waiting for upstream work")
    expect(html).not.toContain("Engineer concern")
    expect(dispatcherIndicator(value).label).toBe("A Train needs attention")
  })
  it("removes acknowledged or resolved advisory cards through the snapshot", () => {
    const value = snapshot()
    value.engineerNotices = []
    expect(render(value)).not.toContain("Acknowledge")
    expect(dispatcherIndicator(value).tone).toBe("idle")
  })
})
