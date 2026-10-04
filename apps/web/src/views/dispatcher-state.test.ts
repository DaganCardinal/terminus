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
    trains: trains.map((status) => ({ train: { state: { status } } })),
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

  it("needs attention for blocked Trains, open conflicts and a stopped plan", () => {
    expect(tone({ trains: ["blocked"], plans: ["ready"] })).toBe("attention")
    expect(tone({ conflicts: ["open"] })).toBe("attention")
    expect(tone({ conflicts: ["resolved"] })).toBe("idle")
    expect(tone({ plans: ["failed"] })).toBe("attention")
    expect(tone({ plans: ["failed", "planning"] })).toBe("working")
  })
})
