import { describe, expect, it } from "vitest"
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_PRESETS,
  effectiveRoleModels,
  modelSettingsSchema,
  roleModels,
  DEFAULT_ROLE_HARNESSES,
  roleHarnesses,
  roleExecutions,
  modelForHarness,
  roleExecutionSchema,
  utilityModel,
} from "./models"

const custom = {
  dispatcher: "@cf/zai-org/glm-5.3",
  conductor: "@cf/moonshotai/kimi-k2.7-code",
  stationAgent: "@cf/zai-org/glm-5.3-flash",
  technician: "@cf/zai-org/glm-5.3",
  engineer: "@cf/cloudflare/clef",
} as const

describe("model settings", () => {
  it("normalizes legacy settings and all presets to OpenCode without changing models", () => {
    for (const settings of [
      { preset: "custom", models: custom },
      ...Object.keys(MODEL_PRESETS).map((preset) => ({ preset })),
    ]) {
      const parsed = modelSettingsSchema.parse(settings)
      expect(roleHarnesses(parsed)).toEqual(DEFAULT_ROLE_HARNESSES)
      expect(roleExecutions(parsed).dispatcher).toMatchObject({
        harness: "opencode",
        version: "1.18.32",
        model: roleModels(parsed).dispatcher,
      })
    }
  })

  it("preserves compatible choices and chooses the cheapest compatible model otherwise", () => {
    expect(modelForHarness("claude-code", custom.dispatcher)).toBe(
      "anthropic/claude-haiku-5-5"
    )
    expect(modelForHarness("codex", custom.dispatcher)).toBe(
      "openai/gpt-6-luna"
    )
    expect(modelForHarness("claude-code", "anthropic/claude-sonnet-5-5")).toBe(
      "anthropic/claude-sonnet-5-5"
    )
    expect(modelForHarness("opencode", "openai/gpt-6-sol")).toBe(
      "openai/gpt-6-sol"
    )
  })

  it("gives each role model the lowest-cost utility model from its own provider", () => {
    expect(utilityModel("@cf/moonshotai/kimi-k2.7-code")).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )
    expect(utilityModel("@cf/zai-org/glm-5.3-flash")).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )
    expect(utilityModel("anthropic/claude-sonnet-5-5")).toBe(
      "anthropic/claude-haiku-5-5"
    )
    expect(utilityModel("openai/gpt-6-sol")).toBe("openai/gpt-6-luna")
    // Decision models are never a harness's utility model.
    expect(utilityModel("@cf/cloudflare/clef")).toBe(
      "@cf/zai-org/glm-5.3-flash"
    )
  })

  it("validates per-role harness compatibility at the settings boundary", () => {
    const settings = {
      preset: "custom",
      models: { ...custom, dispatcher: "openai/gpt-6-luna" },
      harnesses: { ...DEFAULT_ROLE_HARNESSES, dispatcher: "codex" },
    }
    expect(
      roleExecutions(modelSettingsSchema.parse(settings)).dispatcher
    ).toMatchObject({
      harness: "codex",
      provider: "openai",
      version: "0.156.1",
    })
    expect(
      modelSettingsSchema.safeParse({ ...settings, models: custom }).success
    ).toBe(false)
    expect(
      roleExecutionSchema.safeParse({
        harness: "claude-code",
        model: "openai/gpt-6-sol",
      }).success
    ).toBe(false)
    expect(
      roleExecutionSchema.safeParse({ harness: "codex", model: "arbitrary" })
        .success
    ).toBe(false)
  })
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
