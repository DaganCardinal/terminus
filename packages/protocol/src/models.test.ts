import { describe, expect, it } from "vitest"
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_PRESETS,
  effectiveRoleModels,
  modelSettingsSchema,
  roleModels,
} from "./models"

const custom = {
  dispatcher: "@cf/zai-org/glm-5.3",
  conductor: "@cf/moonshotai/kimi-k2.7-code",
  stationAgent: "@cf/zai-org/glm-5.3-flash",
  technician: "@cf/zai-org/glm-5.3",
  engineer: "@cf/cloudflare/clef",
} as const

describe("model settings", () => {
  it("defaults every network to Extra-light", () => {
    expect(roleModels(DEFAULT_MODEL_SETTINGS)).toEqual({
      dispatcher: "@cf/zai-org/glm-5.3-flash",
      conductor: "@cf/zai-org/glm-5.3-flash",
      stationAgent: "@cf/zai-org/glm-5.3-flash",
      technician: "@cf/zai-org/glm-5.3-flash",
      engineer: "@cf/cloudflare/clef-flash",
    })
  })

  it("keeps every preset's Engineer on a decision model", () => {
    for (const models of Object.values(MODEL_PRESETS))
      expect(models.engineer).toMatch(/^@cf\/cloudflare\/clef/)
  })

  it("accepts any custom combination with a Clef Engineer", () => {
    expect(
      modelSettingsSchema.parse({ preset: "custom", models: custom })
    ).toEqual({ preset: "custom", models: custom })
  })

  it("rejects a text model for the Engineer and Clef for text roles", () => {
    expect(
      modelSettingsSchema.safeParse({
        preset: "custom",
        models: { ...custom, engineer: "@cf/zai-org/glm-5.3" },
      }).success
    ).toBe(false)
    expect(
      modelSettingsSchema.safeParse({
        preset: "custom",
        models: { ...custom, dispatcher: "@cf/cloudflare/clef" },
      }).success
    ).toBe(false)
  })

  it("rejects presets that are not offered yet and stray models", () => {
    expect(modelSettingsSchema.safeParse({ preset: "heavy" }).success).toBe(
      false
    )
    expect(
      modelSettingsSchema.safeParse({ preset: "light", models: custom }).success
    ).toBe(false)
  })

  it("lets a network override the General settings", () => {
    const general = { preset: "medium" } as const
    expect(effectiveRoleModels({ override: null, general })).toEqual(
      MODEL_PRESETS.medium
    )
    expect(
      effectiveRoleModels({
        override: { preset: "custom", models: custom },
        general,
      })
    ).toEqual(custom)
  })
})
