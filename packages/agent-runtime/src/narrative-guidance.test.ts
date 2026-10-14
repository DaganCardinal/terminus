import { describe, expect, it, vi } from "vitest"
import type { TechnicianRepair } from "@terminus/domain"
import { narrativeGuidance } from "./narrative-guidance"
import { dispatcherPrompt } from "./dispatcher-prompt"
import { stationAgentPrompt } from "./station-agent-prompt"
import { conductorPrompt, conductorHarnessPrompt } from "./conductor-prompt"
import { conductorSystemPrompt } from "./conductor-agent"
import { ModelRepairConductor, technicianHarnessAgent } from "./technician"

const repair: TechnicianRepair = {
  id: "repair",
  networkId: "network",
  conflictId: "conflict",
  source: {
    integrationId: "integration",
    trainId: "train",
    trainRepoId: "train-repo",
    trainCommit: "train-head",
    trainBaseline: "baseline",
    terminusRepoId: "terminus",
    terminusCommit: "head",
    acceptedCommits: [],
  },
  scope: ["src/app.ts"],
  description: "Resolve a conflict",
  manifests: [],
  expectedChecks: [],
  agent: { model: "fake", harness: "fake" },
  createdAt: "2026-10-13",
  state: { status: "requested" },
}

describe("narrative output guidance", () => {
  it.each([
    ["Dispatcher", dispatcherPrompt],
    ["Station", stationAgentPrompt],
    ["direct Conductor", conductorPrompt],
    ["harness Conductor", conductorHarnessPrompt],
    [
      "Station/Crossing/Junction/repair harness review",
      conductorSystemPrompt("Review the exact candidate"),
    ],
    ["Technician", technicianHarnessAgent(repair).system],
    [
      "Junction Technician",
      technicianHarnessAgent({
        ...repair,
        source: { ...repair.source, junctionId: "junction" },
      }).system,
    ],
  ])("includes shared writing guidance for %s", (_, prompt) => {
    expect(prompt).toContain(narrativeGuidance)
  })
  it("keeps output contracts and brevity without forcing a single paragraph", () => {
    expect(dispatcherPrompt).not.toContain("summary` to a short paragraph")
    expect(dispatcherPrompt).toContain("one or a few short paragraphs")
    expect(conductorPrompt).toContain("Return **only JSON**")
    expect(conductorPrompt).not.toContain("Do not include Markdown, commentary")
    expect(stationAgentPrompt).toContain("well below 8,000 characters")
    expect(narrativeGuidance).toContain("\\n\\n between paragraphs")
  })
  it("keeps paragraph breaks in direct repair verdicts and supplies shared guidance", async () => {
    const summary =
      "The repair preserves the contracts.\n\nIndependent checks passed."
    const provider = {
      generateStructured: vi.fn(async () => ({
        verdict: "accept",
        summary,
        findings: [],
      })),
    }
    const result = await new ModelRepairConductor("fake", provider).review(
      repair
    )
    expect(result.summary).toBe(summary)
    expect(provider.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(narrativeGuidance),
      })
    )
  })
})
