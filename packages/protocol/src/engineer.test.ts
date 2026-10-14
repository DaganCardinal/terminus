import { describe, expect, expectTypeOf, it } from "vitest"
import type { EngineerNotice } from "@terminus/domain"
import type { z } from "zod"
import {
  engineerAssessmentSchema,
  engineerContextSchema,
  engineerNoticeSchema,
} from "./engineer"

describe("Engineer protocol boundaries", () => {
  it("matches the domain notice and rejects excess diagnostic output", () => {
    expectTypeOf<
      z.infer<typeof engineerNoticeSchema>
    >().toEqualTypeOf<EngineerNotice>()
    expect(
      engineerContextSchema.safeParse({
        history: [],
        checks: [
          {
            name: "test",
            required: true,
            status: "failed",
            stdout: "x".repeat(2001),
          },
        ],
      }).success
    ).toBe(false)
  })
  it("refuses cached advice for a different purpose", () => {
    expect(
      engineerAssessmentSchema.safeParse({
        id: "a",
        trainId: "t",
        model: "fake",
        purpose: "revision",
        questionVersion: 1,
        threshold: 0.7,
        input: {},
        advice: { value: "retry", confidence: 1 },
        assessedAt: "now",
      }).success
    ).toBe(false)
  })
})
