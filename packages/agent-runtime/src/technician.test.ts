import { describe, expect, it, vi } from "vitest"
import { ModelRepairConductor, technicianPrompt } from "./technician"
import type { TechnicianRepair } from "@terminus/domain"
const repair: TechnicianRepair = {
  id: "repair",
  networkId: "network",
  conflictId: "conflict",
  source: {
    integrationId: "failed",
    trainId: "train",
    trainRepoId: "train",
    trainCommit: "train-head",
    trainBaseline: "base",
    terminusRepoId: "terminus",
    terminusCommit: "terminus-head",
    acceptedCommits: ["car"],
  },
  scope: ["src/shared.ts"],
  description: "Two incompatible edits",
  manifests: [],
  expectedChecks: ["test"],
  agent: { model: "configured", harness: "opencode" },
  createdAt: "2026-10-04",
  state: { status: "requested" },
}
describe("Technician runtime", () => {
  it("gives the harness exact reconciliation context and constrained implementation authority", () => {
    const prompt = technicianPrompt(repair)
    expect(prompt).toContain("Edit only the listed conflicted files")
    expect(prompt).toContain("cannot approve or promote")
    expect(prompt).toContain("train-head")
    expect(prompt).toContain("terminus-head")
    expect(prompt).toContain("src/shared.ts")
  })
  it("validates the affected Conductor's structured output and records its configured identity", async () => {
    const provider = {
      generateStructured: vi.fn(async () => ({
        verdict: "accept",
        summary: "Preserves both contracts",
        findings: [],
      })),
    }
    const reviewer = new ModelRepairConductor("configured-conductor", provider)
    expect(await reviewer.review(repair)).toMatchObject({
      model: "configured-conductor",
      verdict: "accept",
    })
    expect(provider.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ role: "conductor", input: repair })
    )
    provider.generateStructured.mockResolvedValue({
      verdict: "silently-promote",
      summary: "Unsafe",
      findings: [],
    })
    await expect(reviewer.review(repair)).rejects.toThrow()
  })
})
