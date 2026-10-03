import { describe, expect, it } from "vitest"
import { holdsApplyingTo, placeHold, releaseHold, type Hold } from "./hold"
import { eventTypes, expectRejected, unwrap } from "./testing"

const hold: Hold = {
  id: "h1",
  kind: "user",
  scope: { kind: "line", lineId: "red" },
  note: "waiting on design",
}

describe("holds", () => {
  it("places and releases a hold", () => {
    const placed = placeHold(hold)
    expect(unwrap(placed)).toEqual(hold)
    expect(eventTypes(placed)).toEqual(["hold.placed"])
    expect(eventTypes(releaseHold(hold, [hold]))).toEqual(["hold.released"])
  })

  it("rejects releasing a hold that is not active", () => {
    expectRejected(releaseHold(hold, []), "invalid_state")
  })

  it("applies by scope", () => {
    const train = { id: "t", lineId: "red" }
    expect(holdsApplyingTo(train, [hold])).toEqual([hold])
    expect(holdsApplyingTo({ id: "t", lineId: "blue" }, [hold])).toEqual([])
  })
})
