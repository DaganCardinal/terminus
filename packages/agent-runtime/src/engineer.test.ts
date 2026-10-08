import { describe, expect, it, vi } from "vitest"
import type { Station, Train } from "@terminus/domain"
import type { DecisionAnswer } from "@terminus/protocol"
import { GatewayDecisionModel, type DecisionModel } from "./decision-model"
import {
  ENGINEER_QUESTIONS,
  ModelEngineer,
  stationBrief,
  type NoticeSituation,
  type StationFailureSituation,
} from "./engineer"
import { FakeEngineer } from "./fakes"
import type { ModelTransport } from "./model-provider"

const model = "@cf/cloudflare/clef-flash"
const situation: NoticeSituation = {
  train: { id: "t" } as unknown as Train,
  gate: { kind: "clear" },
}
const station = {
  id: "s1",
  name: "Footer",
  manifest: { goal: "Add a footer", acceptanceCriteria: ["Accessible"] },
  revisionCount: 1,
  retryCount: 1,
  state: { status: "active" },
} as unknown as Station
const failure: StationFailureSituation = {
  station: stationBrief(station),
  issues: [
    {
      kind: "station_failed",
      detail: "Station run failed during dependencies: npm ci exited 1",
    },
  ],
}
const feedback = { summary: "Missing label", findings: ["Add aria-label"] }

function answering(answer: DecisionAnswer) {
  return vi.fn<DecisionModel["decide"]>(async (request) =>
    Object.fromEntries(Object.keys(request.questions).map((id) => [id, answer]))
  )
}

const choice = (probabilities: Record<string, number>): DecisionAnswer => ({
  type: "choice",
  choice: "retry",
  probabilities,
  confidence: Math.max(...Object.values(probabilities)),
})

describe("Clef decision model", () => {
  it("calls the Workers AI run endpoint through the Gateway", async () => {
    const transport = vi.fn<ModelTransport>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          model: "clef-flash",
          answers: { notify_dispatcher: { type: "noul", noul: 0.2 } },
          usage: { input_tokens: 120, output_tokens: 0 },
        },
      }),
    }))
    const decisions = new GatewayDecisionModel(
      { accountId: "account", gatewayId: "gateway", token: "test", model },
      transport
    )
    const questions = {
      notify_dispatcher: ENGINEER_QUESTIONS.notify_dispatcher,
    }
    expect(
      await decisions.decide({ role: "engineer", state: situation, questions })
    ).toEqual({ notify_dispatcher: { type: "noul", noul: 0.2 } })
    const [url, request] = transport.mock.calls[0]!
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/cloudflare/clef-flash"
    )
    expect(JSON.parse(request.body)).toEqual({
      model: "clef-flash",
      state: situation,
      questions,
    })
    expect(request.headers["cf-aig-gateway-id"]).toBe("gateway")
  })
  it("rejects failed requests and missing or mistyped answers", async () => {
    const respond =
      (ok: boolean, answers: unknown): ModelTransport =>
      async () => ({
        ok,
        status: ok ? 200 : 503,
        json: async () => ({ result: { answers } }),
      })
    const decide = (transport: ModelTransport) =>
      new GatewayDecisionModel(
        { accountId: "account", gatewayId: "gateway", token: "test", model },
        transport
      ).decide({
        role: "engineer",
        state: {},
        questions: { notify_dispatcher: ENGINEER_QUESTIONS.notify_dispatcher },
      })
    await expect(decide(respond(false, {}))).rejects.toThrow("503")
    await expect(decide(respond(true, {}))).rejects.toThrow(
      "did not answer notify_dispatcher"
    )
    await expect(
      decide(respond(true, { notify_dispatcher: choice({ retry: 1 }) }))
    ).rejects.toThrow("did not answer notify_dispatcher")
  })
  it("rejects malformed questions before calling the model", async () => {
    const transport = vi.fn<ModelTransport>()
    await expect(
      new GatewayDecisionModel(
        { accountId: "account", gatewayId: "gateway", token: "test", model },
        transport
      ).decide({
        role: "engineer",
        state: {},
        questions: {
          only: { type: "choice", instructions: "Pick", criteria: { a: null } },
        },
      })
    ).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
})

describe("model Engineer", () => {
  it("summarizes a Station without diffs, with its remaining allowance", () => {
    expect(stationBrief(station, 3)).toEqual({
      id: "s1",
      name: "Footer",
      goal: "Add a footer",
      acceptanceCriteria: ["Accessible"],
      revisionCount: 1,
      runRetries: 0,
      retriesRemaining: 2,
    })
  })
  it("acts on a confident failure triage and asks only that question", async () => {
    const decide = answering(choice({ retry: 0.1, wait: 0.85, escalate: 0.05 }))
    const advice = await new ModelEngineer(model, { decide }).stationFailure(
      failure
    )
    expect(advice).toEqual({ value: "wait", confidence: 0.85 })
    expect(decide.mock.calls[0]![0]).toEqual({
      role: "engineer",
      state: failure,
      questions: { station_failure: ENGINEER_QUESTIONS.station_failure },
    })
  })
  it("blocks a failed run, as before, when unsure or when the model fails", async () => {
    const unsure = answering(choice({ retry: 0.5, wait: 0.4, escalate: 0.1 }))
    expect(
      (
        await new ModelEngineer(model, { decide: unsure }).stationFailure(
          failure
        )
      ).value
    ).toBe("escalate")
    const failing: DecisionModel = {
      decide: async () => {
        throw new Error("engineer decision request failed (503)")
      },
    }
    expect(
      await new ModelEngineer(model, failing).stationFailure(failure)
    ).toEqual({
      value: "escalate",
      confidence: null,
      error: "engineer decision request failed (503)",
    })
  })
  it("stops a revision loop only when confident", async () => {
    const revision = (probabilities: Record<string, number>) =>
      new ModelEngineer(model, {
        decide: answering(choice(probabilities)),
      }).revision({
        station: stationBrief(station),
        feedback,
        previousFeedback: feedback,
      })
    expect((await revision({ revise: 0.1, escalate: 0.9 })).value).toBe(
      "escalate"
    )
    expect((await revision({ revise: 0.4, escalate: 0.6 })).value).toBe(
      "revise"
    )
    const failing: DecisionModel = {
      decide: async () => {
        throw new Error("down")
      },
    }
    expect(
      (
        await new ModelEngineer(model, failing).revision({
          station: stationBrief(station),
          feedback,
          previousFeedback: null,
        })
      ).value
    ).toBe("revise")
  })
  it("notifies the Dispatcher unless the model is confident it needn't", async () => {
    const notify = (noul: number) =>
      new ModelEngineer(model, {
        decide: answering({ type: "noul", noul }),
      }).notifyDispatcher(situation)
    expect(await notify(0.1)).toEqual({ value: false, confidence: 0.9 })
    expect((await notify(0.5)).value).toBe(true)
    expect((await notify(0.9)).value).toBe(true)
  })
  it("has a fake that keeps the deterministic behavior by default", async () => {
    const fake = new FakeEngineer()
    expect((await fake.stationFailure()).value).toBe("escalate")
    expect((await fake.revision()).value).toBe("revise")
    expect((await fake.notifyDispatcher()).value).toBe(false)
  })
})
