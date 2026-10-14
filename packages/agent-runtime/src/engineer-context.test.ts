import { describe, expect, it } from "vitest"
import { boundEngineerContext, engineerText } from "./engineer-context"

describe("Engineer diagnostic context", () => {
  it("bounds four historical attempts and the total diagnostic budget", () => {
    const context = boundEngineerContext({
      history: Array.from({ length: 6 }, (_, i) => ({
        runId: `r${i}`,
        at: "now",
        allowance: "current",
        feedback: { summary: "x".repeat(4000), findings: ["y".repeat(4000)] },
        checks: [
          {
            name: "test",
            required: true,
            status: "failed",
            stdout: "a".repeat(6000),
            stderr: "b".repeat(6000),
          },
        ],
      })),
    })
    expect(context.history.map((entry) => entry.runId)).toEqual([
      "r2",
      "r3",
      "r4",
      "r5",
    ])
    expect(context.truncated).toBe(true)
    const text = context.history
      .flatMap((entry) => [
        entry.feedback?.summary ?? "",
        ...(entry.feedback?.findings ?? []),
        ...(entry.checks ?? []).flatMap((check) => [
          check.name,
          check.stdout ?? "",
        ]),
      ])
      .join("")
    expect(text.length).toBeLessThanOrEqual(12000)
    expect(
      context.history
        .flatMap((entry) => entry.checks ?? [])
        .every((check) => (check.stdout?.length ?? 0) <= 2000)
    ).toBe(true)
  })
  it("prioritizes independent current checks and strips credentials from diagnostics", () => {
    const context = boundEngineerContext({
      history: [],
      checks: [
        {
          name: "test",
          status: "failed",
          required: true,
          stdout:
            "Authorization: Bearer secret-token\nAPI_KEY=secret\nhttps://user:pass@example.com",
          stderr: "sk-proj-abcdef",
        },
      ],
    })
    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain("secret-token")
    expect(serialized).not.toContain("sk-proj-abcdef")
    expect(serialized).not.toContain("user:pass")
    expect(engineerText("password=foo")).toBe("password=[redacted]")
  })
})
