import { describe, expect, it } from "vitest"
import { evidenceCovers, unmetRequiredChecks } from "./evidence"

describe("reusable validation evidence", () => {
  const validation = [
    { name: "test", command: ["npm", "test"] },
    { name: "build", command: ["npm", "run", "build"] },
  ]
  const passed = (name: string, command: string[]) => ({
    name,
    command,
    required: true,
    status: "passed" as const,
  })
  const evidence = {
    checks: [
      passed("npm ci", ["npm", "ci"]),
      passed("test", ["npm", "test"]),
      passed("build", ["npm", "run", "build"]),
    ],
  }

  it("covers configured checks that passed with the same commands", () => {
    expect(evidenceCovers(evidence, validation)).toBe(true)
  })
  it("never treats an empty record as proof", () => {
    expect(evidenceCovers({ checks: [] }, [])).toBe(false)
  })
  it("rejects a configured check that is missing or did not pass", () => {
    expect(
      evidenceCovers({ checks: evidence.checks.slice(0, 2) }, validation)
    ).toBe(false)
    expect(
      evidenceCovers(
        {
          checks: [
            ...evidence.checks.slice(0, 2),
            { ...evidence.checks[2]!, status: "skipped" },
          ],
        },
        validation
      )
    ).toBe(false)
  })
  it("rejects a check recorded under a different command", () => {
    expect(
      evidenceCovers(evidence, [
        { name: "test", command: ["npm", "test", "--", "--bail"] },
      ])
    ).toBe(false)
  })
  it("rejects evidence with any failed required check", () => {
    expect(
      evidenceCovers(
        {
          checks: [
            ...evidence.checks,
            { name: "lint", required: true, status: "failed" },
          ],
        },
        validation
      )
    ).toBe(false)
  })
})

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
