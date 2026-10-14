import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROLE_HARNESSES,
  MODEL_PRESETS,
  type ModelSettings,
} from "@terminus/protocol"
import {
  alternativeHarnessesEnabled,
  harnessExecutionEnabled,
  opencodeExternalProvidersEnabled,
  unavailableHarnessSettings,
} from "./harness-availability"

describe("harness release gate", () => {
  const real = {
    REPOSITORY_MODE: "artifacts",
    ALTERNATIVE_HARNESSES_ENABLED: "false",
    OPENCODE_EXTERNAL_PROVIDERS_ENABLED: "false",
  }
  const custom: ModelSettings = {
    preset: "custom",
    harnesses: { ...DEFAULT_ROLE_HARNESSES, stationAgent: "codex" },
    models: { ...MODEL_PRESETS.extra_light, stationAgent: "openai/gpt-6-luna" },
  }
  const opencodeAnthropic: ModelSettings = {
    preset: "custom",
    harnesses: DEFAULT_ROLE_HARNESSES,
    models: {
      ...MODEL_PRESETS.extra_light,
      conductor: "anthropic/claude-haiku-4-5-20251001",
    },
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
    const fake = { ...real, REPOSITORY_MODE: "fake" }
    expect(unavailableHarnessSettings(fake, custom)).toBe(false)
    expect(unavailableHarnessSettings(fake, opencodeAnthropic)).toBe(false)
    expect(opencodeExternalProvidersEnabled(fake)).toBe(true)
    expect(
      unavailableHarnessSettings(
        { ...real, ALTERNATIVE_HARNESSES_ENABLED: "true" },
        custom
      )
    ).toBe(false)
  })
  it("keeps Anthropic and OpenAI under OpenCode behind their own gate", () => {
    const alternatives = { ...real, ALTERNATIVE_HARNESSES_ENABLED: "true" }
    expect(opencodeExternalProvidersEnabled(alternatives)).toBe(false)
    expect(unavailableHarnessSettings(alternatives, opencodeAnthropic)).toBe(
      true
    )
    for (const provider of ["anthropic", "openai"] as const)
      expect(harnessExecutionEnabled(alternatives, "opencode", provider)).toBe(
        false
      )
    expect(
      harnessExecutionEnabled(alternatives, "claude-code", "anthropic")
    ).toBe(true)
    expect(harnessExecutionEnabled(alternatives, "codex", "openai")).toBe(true)

    // The OpenCode gate alone never enables paid providers.
    const opencodeOnly = {
      ...real,
      OPENCODE_EXTERNAL_PROVIDERS_ENABLED: "true",
    }
    expect(opencodeExternalProvidersEnabled(opencodeOnly)).toBe(false)
    expect(unavailableHarnessSettings(opencodeOnly, opencodeAnthropic)).toBe(
      true
    )

    const both = {
      ...alternatives,
      OPENCODE_EXTERNAL_PROVIDERS_ENABLED: "true",
    }
    expect(opencodeExternalProvidersEnabled(both)).toBe(true)
    expect(unavailableHarnessSettings(both, opencodeAnthropic)).toBe(false)
    expect(harnessExecutionEnabled(real, "opencode", "workers-ai")).toBe(true)
  })
})
