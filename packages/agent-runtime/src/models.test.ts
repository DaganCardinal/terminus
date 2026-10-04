import { describe, expect, it, vi } from "vitest"
import {
  GatewayModelProvider,
  type ModelProvider,
  type ModelTransport,
} from "./model-provider"
import { ModelConductor } from "./model-conductor"
import { harnessOutcome, opencodeConfig, opencodeCommand } from "./opencode"
import type { ReviewInput, StationRunInput } from "./roles"

const model = "@cf/zai-org/glm-5.3-flash"
const manifest = {
  goal: "Add a footer",
  scope: [],
  expectedAreas: ["footer.tsx"],
  avoidAreas: ["package.json"],
  contracts: [],
  invariants: [],
  dependencies: [],
  acceptanceCriteria: ["Accessible footer"],
  expectedEvidence: ["test"],
}
const review: ReviewInput = {
  stationId: "station",
  manifest,
  trainHead: "base",
  revisionCount: 0,
  proposal: {
    headCommit: "candidate",
    changedPaths: ["footer.tsx"],
    diff: "+export function Footer() {}",
    evidence: {
      checks: [
        {
          name: "test",
          required: true,
          status: "passed",
          exitCode: 0,
          stdout: "1 test passed",
        },
      ],
    },
    agent: { harness: "opencode", model },
    agentSummary: "Done",
  },
}
const run: StationRunInput = {
  stationId: "station",
  runId: "run",
  manifest,
  workspace: { repoId: "repo", baseCommit: "base" },
  feedback: null,
}

describe("real Conductor", () => {
  it("reviews the patch and independent evidence, validates structured output", async () => {
    const generateStructured = vi.fn<ModelProvider["generateStructured"]>(
      async () => ({
        verdict: "return",
        summary: "Missing accessibility",
        findings: ["Add a navigation label"],
      })
    )
    const conductor = new ModelConductor(model, { generateStructured })
    expect((await conductor.review(review)).verdict).toBe("return")
    expect(generateStructured.mock.calls[0]![0]).toMatchObject({
      role: "conductor",
      input: review,
    })
  })
  it("does not call a model when required evidence is missing", async () => {
    const generateStructured = vi.fn()
    const result = await new ModelConductor(model, {
      generateStructured,
    }).review({
      ...review,
      proposal: { ...review.proposal, evidence: { checks: [] } },
    })
    expect(result.verdict).toBe("return")
    expect(generateStructured).not.toHaveBeenCalled()
  })
  it("does not approve an absent diff or malformed model verdict", async () => {
    const conductor = new ModelConductor(model, {
      generateStructured: async () => ({ verdict: "ship_it" }),
    })
    expect(
      (
        await conductor.review({
          ...review,
          proposal: { ...review.proposal, diff: undefined },
        })
      ).verdict
    ).toBe("escalate")
    await expect(conductor.review(review)).rejects.toThrow()
  })
})

describe("configured model routing", () => {
  it("uses GLM Flash and the configured Gateway without an alternate model", async () => {
    const transport = vi.fn<ModelTransport>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"verdict":"accept"}' },
          },
        ],
      }),
    }))
    const provider = new GatewayModelProvider(
      {
        accountId: "account",
        gatewayId: "gateway",
        token: "test-token",
        model,
      },
      transport
    )
    expect(
      await provider.generateStructured({
        role: "conductor",
        system: "Review",
        input: {},
      })
    ).toEqual({ verdict: "accept" })
    const [url, request] = transport.mock.calls[0]!
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions"
    )
    expect(JSON.parse(request.body)).toMatchObject({
      model,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      max_completion_tokens: 8192,
    })
    expect(request.headers["cf-aig-gateway-id"]).toBe("gateway")
  })
  it("rejects failed or truncated model responses without retrying another model", async () => {
    const transport = vi.fn<ModelTransport>(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }))
    await expect(
      new GatewayModelProvider(
        { accountId: "account", gatewayId: "gateway", token: "test", model },
        transport
      ).generateStructured({ role: "conductor", system: "Review", input: {} })
    ).rejects.toThrow("429")
    expect(transport).toHaveBeenCalledTimes(1)
    const truncated: ModelTransport = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
      }),
    })
    await expect(
      new GatewayModelProvider(
        { accountId: "account", gatewayId: "gateway", token: "test", model },
        truncated
      ).generateStructured({ role: "conductor", system: "Review", input: {} })
    ).rejects.toThrow("truncated")
  })
  it("pins both OpenCode model choices and uses only a placeholder key in the Sandbox", () => {
    const config = JSON.parse(opencodeConfig("account", "gateway", model))
    expect(config.model).toBe(`terminus/${model}`)
    expect(config.small_model).toBe(config.model)
    expect(config.enabled_providers).toEqual(["terminus"])
    expect(config.snapshot).toBe(false)
    expect(config.provider.terminus.options.apiKey).toBe("provided-by-worker")
    expect(opencodeCommand(model, run)).toContain(`terminus/${model}`)
  })
})

describe("OpenCode outcomes", () => {
  it("collects summaries from JSON events without treating them as evidence", () => {
    expect(
      harnessOutcome({
        exitCode: 0,
        stdout:
          '{"type":"text","part":{"text":"Done"}}\n{"type":"step_finish"}',
        stderr: "",
      })
    ).toEqual({ summary: "Done", error: null })
  })
  it("treats harness error events as failures even when the process exits zero", () => {
    expect(
      harnessOutcome({
        exitCode: 0,
        stdout:
          '{"type":"error","error":{"name":"APIError","data":{"message":"Rate limited"}}}',
        stderr: "",
      }).error
    ).toBe("Rate limited")
    expect(
      harnessOutcome({ exitCode: 1, stdout: "", stderr: "" }).error
    ).toContain("exited with 1")
  })
})
