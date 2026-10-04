import { describe, expect, it, vi } from "vitest"
import { dispatchProposalSchema } from "@terminus/protocol"
import {
  FakeDispatchPlanner,
  DispatchProposalError,
  ModelDispatcher,
  type DispatchPlanningInput,
} from "./model-dispatcher"
import type { ModelProvider } from "./model-provider"
import { liveDispatcherProposal } from "./model-dispatcher.fixture"

const input: DispatchPlanningInput = {
  goal: "Add a footer",
  repository: {
    commit: "base",
    paths: ["src/App.tsx"],
    pathsTruncated: false,
    files: [
      {
        path: "src/App.tsx",
        content: "export function App() {}",
        truncated: false,
      },
    ],
  },
  network: { validationNames: ["test"], activeLines: [] },
}

describe("model Dispatcher", () => {
  it("uses repository and network context through the configured role, without executing the plan", async () => {
    const proposal = await new FakeDispatchPlanner().plan(input)
    const generateStructured = vi.fn<ModelProvider["generateStructured"]>(
      async () => proposal
    )
    expect(
      await new ModelDispatcher("configured", { generateStructured }).plan(
        input
      )
    ).toEqual(proposal)
    expect(generateStructured).toHaveBeenCalledOnce()
    expect(generateStructured.mock.calls[0]![0]).toMatchObject({
      role: "dispatcher",
      input,
    })
    expect(generateStructured.mock.calls[0]![0].system).toContain(
      "untrusted context"
    )
    expect(generateStructured.mock.calls[0]![0].system).toContain(
      "SAME canonical baseline"
    )
  })
  it("rejects malformed or command-bearing output and incomplete manifests", async () => {
    for (const output of [
      { lines: [] },
      { command: "deploy", lines: [] },
      { ...(await new FakeDispatchPlanner().plan(input)), summary: "" },
    ]) {
      await expect(
        new ModelDispatcher("configured", {
          generateStructured: async () => output,
        }).plan(input)
      ).rejects.toThrow()
    }
    const proposal = await new FakeDispatchPlanner().plan(input)
    proposal.lines[0]!.stations[0]!.manifest.acceptanceCriteria = []
    expect(dispatchProposalSchema.safeParse(proposal).success).toBe(false)
  })
  it("repairs the live path-field failure with exact validation feedback and preserves the plan", async () => {
    const result = dispatchProposalSchema.safeParse(liveDispatcherProposal)
    expect(result.success).toBe(false)
    if (result.success)
      throw new Error("Expected the original live response to fail")
    expect([
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ]).toEqual([
      "lines.0.stations.0.manifest.expectedAreas.1",
      "lines.0.stations.0.manifest.avoidAreas.6",
    ])
    const corrected = JSON.parse(
      JSON.stringify(liveDispatcherProposal)
    ) as typeof liveDispatcherProposal
    const work = corrected.lines[0]!.stations[0]!.manifest
    work.expectedAreas[1] = "src/components/ui/button.tsx"
    work.avoidAreas.pop()
    work.invariants.push(
      "All other colour tokens such as --accent, --ring, and --chart-* remain unchanged."
    )
    const generateStructured = vi
      .fn<ModelProvider["generateStructured"]>()
      .mockResolvedValueOnce(liveDispatcherProposal)
      .mockResolvedValueOnce(corrected)
    const goal = {
      ...input,
      goal: "Change the primary accent colour to #32a852",
      network: { ...input.network, validationNames: ["build", "test"] },
    }
    expect(
      await new ModelDispatcher("configured", { generateStructured }).plan(goal)
    ).toEqual(corrected)
    expect(generateStructured).toHaveBeenCalledTimes(2)
    expect(generateStructured.mock.calls[1]![0].input).toMatchObject({
      ...goal,
      repair: {
        previousProposal: liveDispatcherProposal,
        issues: expect.arrayContaining([
          {
            path: "lines.0.stations.0.manifest.expectedAreas.1",
            code: "invalid_format",
          },
          {
            path: "lines.0.stations.0.manifest.avoidAreas.6",
            code: "invalid_format",
          },
        ]),
      },
    })
    expect(generateStructured.mock.calls[0]![0].system).toContain(
      "ONLY plain paths"
    )
  })
  it("bounds correction attempts and exposes field codes without raw values or unknown keys", async () => {
    const invalid = {
      ...liveDispatcherProposal,
      "private-response-text": "secret",
    }
    const generateStructured = vi.fn<ModelProvider["generateStructured"]>(
      async () => invalid
    )
    const error = await new ModelDispatcher("configured", {
      generateStructured,
    })
      .plan(input)
      .catch((error: unknown) => error)
    expect(generateStructured).toHaveBeenCalledTimes(3)
    expect(error).toBeInstanceOf(DispatchProposalError)
    if (!(error instanceof DispatchProposalError))
      throw new Error("Expected safe validation error")
    expect(error.message).toContain("expectedAreas.1 (invalid_format)")
    expect(error.message).not.toContain("private-response-text")
    expect(error.message).not.toContain("secret")
    expect(error.message).not.toContain("consumes --primary")
    expect(error.issues).toContainEqual({
      path: "$",
      code: "unrecognized_keys",
    })
  })
  it("leaves transient provider failures to the durable execution layer", async () => {
    const generateStructured = vi.fn<ModelProvider["generateStructured"]>(
      async () => {
        throw new Error("429")
      }
    )
    await expect(
      new ModelDispatcher("configured", { generateStructured }).plan(input)
    ).rejects.toThrow("429")
    expect(generateStructured).toHaveBeenCalledOnce()
  })
  it("makes fake execution explicit and supports the bounded goal input", async () => {
    const planner = new FakeDispatchPlanner()
    expect(planner.model).toBe("fake")
    const result = dispatchProposalSchema.parse(
      await planner.plan({ ...input, goal: "a".repeat(4000) })
    )
    expect(result.summary).toContain("Simulated")
    expect(result.lines[0]!.stations[0]!.manifest.expectedEvidence).toEqual([
      "test",
    ])
  })
})
