import { describe, expect, it } from "vitest"
import { modelWithReasoning } from "./describe"

describe("modelWithReasoning", () => {
  it("names the level an agent ran at, and nothing for older provenance", () => {
    expect(
      modelWithReasoning({ model: "openai/gpt-6-sol", reasoning: "xhigh" })
    ).toBe("openai/gpt-6-sol (Extra high reasoning)")
    expect(modelWithReasoning({ model: "openai/gpt-6-sol" })).toBe(
      "openai/gpt-6-sol"
    )
  })
})
