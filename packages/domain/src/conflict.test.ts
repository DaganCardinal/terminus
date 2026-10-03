import { describe, expect, it } from "vitest"
import { detectConflict, openConflictsFor, resolveConflict } from "./conflict"
import { eventTypes, expectRejected, unwrap } from "./testing"

const input = {
  id: "c1",
  trainIds: ["t", "u"],
  paths: ["src/api.ts"],
  description: "Both change the login route",
}

describe("conflicts", () => {
  it("detects, lists, and resolves a conflict", () => {
    const detected = detectConflict(input)
    const conflict = unwrap(detected)
    expect(eventTypes(detected)).toEqual(["conflict.detected"])
    expect(openConflictsFor("t", [conflict])).toEqual([conflict])
    expect(openConflictsFor("other", [conflict])).toEqual([])

    const resolved = resolveConflict(conflict)
    expect(eventTypes(resolved)).toEqual(["conflict.resolved"])
    expect(openConflictsFor("t", [unwrap(resolved)])).toEqual([])
  })

  it("rejects a conflict with no Trains", () => {
    expectRejected(detectConflict({ ...input, trainIds: [] }), "invalid_input")
  })

  it("rejects resolving a resolved conflict", () => {
    const resolved = unwrap(resolveConflict(unwrap(detectConflict(input))))
    expectRejected(resolveConflict(resolved), "invalid_state")
  })
})
