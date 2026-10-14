import { describe, expect, it } from "vitest"
import type { NetworkSnapshot } from "@terminus/protocol"
import { dispatcherIndicator } from "./dispatcher-state"

type Parts = {
  trains?: string[]
  conflicts?: ("open" | "resolved")[]
  plans?: string[]
}

/** Only the fields the indicator reads; the rest of the snapshot is irrelevant. */
const snapshot = ({ trains = [], conflicts = [], plans = [] }: Parts) =>
  ({
    trains: trains.map((status) => ({
      train: { state: { status, reasons: [] } },
    })),
    conflicts: conflicts.map((status) => ({ status })),
    plans: plans.map((status) => ({ state: { status } })),
  }) as unknown as NetworkSnapshot

const tone = (parts: Parts) => dispatcherIndicator(snapshot(parts)).tone

describe("dispatcher indicator", () => {
  it("is idle with nothing for the Dispatcher to do", () => {
    expect(tone({})).toBe("idle")
    expect(tone({ trains: ["in_transit", "held"], plans: ["launched"] })).toBe(
      "idle"
    )
  })

  it("is working while the latest plan is being prepared or launched", () => {
    expect(tone({ plans: ["planning"] })).toBe("working")
    expect(tone({ plans: ["launched", "launching"] })).toBe("working")
    expect(tone({ plans: ["starting"] })).toBe("working")
  })

  it("waits on the user when the latest plan is ready", () => {
    expect(tone({ plans: ["ready"] })).toBe("review")
    expect(tone({ plans: ["ready", "launched"] })).toBe("idle")
  })

  it("shows a persistent review indication while a Train awaits unloading approval", () => {
    const current = snapshot({})
    current.trains = [
      {
        train: {
          state: {
            status: "held",
            reasons: [{ kind: "awaiting_user_approval", trainCommit: "head" }],
          },
        },
      },
    ] as unknown as NetworkSnapshot["trains"]
    expect(dispatcherIndicator(current)).toEqual({
      tone: "review",
      label: "1 Train awaits approval",
    })
  })

  it("needs attention for blocked Trains, open conflicts and a stopped plan", () => {
    expect(tone({ trains: ["blocked"], plans: ["ready"] })).toBe("attention")
    expect(tone({ conflicts: ["open"] })).toBe("attention")
    expect(tone({ conflicts: ["resolved"] })).toBe("idle")
    expect(tone({ plans: ["failed"] })).toBe("attention")
    expect(tone({ plans: ["failed", "planning"] })).toBe("working")
  })
})

it("treats a user stop as idle instead of an intervention alert", () => {
  const current = snapshot({})
  current.plans = [
    { state: { status: "failed", reason: "cancelled", message: "Stopped" } },
  ] as NetworkSnapshot["plans"]
  expect(dispatcherIndicator(current)).toEqual({
    tone: "idle",
    label: "Planning stopped",
  })
  current.plans[0]!.state = {
    status: "failed",
    reason: "cancelled",
    message: "Stopped",
    cleanupPending: true,
  }
  expect(dispatcherIndicator(current)).toEqual({
    tone: "working",
    label: "Stopping planning",
  })
})
