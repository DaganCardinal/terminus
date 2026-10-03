import { describe, expect, it } from "vitest"
import { unmetRequiredChecks } from "./evidence"

describe("required validation evidence", () => {
  it("treats missing evidence as a skipped required check", () => {
    expect(unmetRequiredChecks({ checks: [] }, ["test"])).toEqual([
      { name: "test", required: true, status: "skipped" },
    ])
  })
  it("requires manifest evidence even if a runner marks the failed check optional", () => {
    expect(
      unmetRequiredChecks(
        { checks: [{ name: "test", required: false, status: "failed" }] },
        ["test"]
      )
    ).toHaveLength(1)
  })
  it("allows passing expected checks and retains other required failures", () => {
    expect(
      unmetRequiredChecks(
        {
          checks: [
            { name: "test", required: true, status: "passed" },
            { name: "build", required: true, status: "failed" },
          ],
        },
        ["test"]
      )
    ).toEqual([{ name: "build", required: true, status: "failed" }])
  })
})
