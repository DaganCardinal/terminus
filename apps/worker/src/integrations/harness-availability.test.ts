import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROLE_HARNESSES,
  MODEL_PRESETS,
  type ModelSettings,
} from "@terminus/protocol"
import {
  alternativeHarnessesEnabled,
  unavailableHarnessSettings,
} from "./harness-availability"

describe("harness release gate", () => {
  const real = {
    REPOSITORY_MODE: "artifacts",
    ALTERNATIVE_HARNESSES_ENABLED: "false",
  }
  const custom: ModelSettings = {
    preset: "custom",
    harnesses: { ...DEFAULT_ROLE_HARNESSES, stationAgent: "codex" },
    models: { ...MODEL_PRESETS.extra_light, stationAgent: "openai/gpt-6-luna" },
  }
  it("allows presets, legacy normalization and reverting to General before release", () => {
    expect(alternativeHarnessesEnabled(real)).toBe(false)
    expect(unavailableHarnessSettings(real, { preset: "medium" })).toBe(false)
    expect(unavailableHarnessSettings(real, null)).toBe(false)
    expect(unavailableHarnessSettings(real, custom)).toBe(true)
    expect(
      unavailableHarnessSettings(real, {
        ...custom,
        harnesses: DEFAULT_ROLE_HARNESSES,
      })
    ).toBe(true)
  })
  it("allows all fake settings and explicitly enabled real configurations", () => {
    expect(
      unavailableHarnessSettings({ ...real, REPOSITORY_MODE: "fake" }, custom)
    ).toBe(false)
    expect(
      unavailableHarnessSettings(
        { ...real, ALTERNATIVE_HARNESSES_ENABLED: "true" },
        custom
      )
    ).toBe(false)
  })
})
