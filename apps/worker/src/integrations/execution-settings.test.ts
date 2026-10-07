import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  FakeDispatchPlanner,
  FakeConductor,
  agentProvenance,
  executionConfig,
} from "@terminus/agent-runtime"
import {
  DEFAULT_ROLE_HARNESSES,
  MODEL_PRESETS,
  roleExecutions,
  type Harness,
  type ModelSettings,
} from "@terminus/protocol"
import {
  drive,
  manifest,
  seedLine,
  seedNetwork,
  testPorts,
} from "../../test/fixtures"
import { planModels, trainModels } from "../agents/ports"
import { proposeDispatchPlan } from "../agents/dispatch-planning"
import { layJunction } from "../agents/junctions"
import { NetworkStore } from "./network-store"

const at = "2026-10-07T12:00:00.000Z"
const settings = (harness: Harness, model: string): ModelSettings => ({
  preset: "custom",
  models: {
    ...MODEL_PRESETS.extra_light,
    dispatcher: model,
    conductor: model,
    stationAgent: model,
    technician: model,
  } as Extract<ModelSettings, { preset: "custom" }>["models"],
  harnesses: {
    ...DEFAULT_ROLE_HARNESSES,
    dispatcher: harness,
    conductor: harness,
    stationAgent: harness,
    technician: harness,
  },
})

describe("immutable execution settings", () => {
  it.each([
    ["opencode", "@cf/zai-org/glm-5.3-flash"],
    ["claude-code", "anthropic/claude-haiku-4-5-20251001"],
    ["codex", "openai/gpt-6-luna"],
  ] as const)(
    "keeps %s for every Station and revision and runs fully offline",
    async (harness, model) => {
      const p = testPorts({ conductor: new FakeConductor({ returns: 1 }) }),
        network = await seedNetwork(p)
      await p.store.setNetworkModelSettings(
        network.id,
        settings(harness, model),
        at
      )
      const { train } = await seedLine(p, network.id)
      const frozen = await trainModels(env, train.id)
      await p.store.setNetworkModelSettings(
        network.id,
        { preset: "medium" },
        at
      )
      await drive(p, train.id)
      expect(await trainModels(env, train.id)).toEqual(frozen)
      expect(frozen.executions!.stationAgent).toMatchObject({ harness, model })
      expect(frozen.executions!.conductor).toMatchObject({ harness, model })
      expect(p.runs).toHaveLength(4)
      await expect(
        env.DB.prepare(
          "UPDATE execution_configs SET config = '{}' WHERE work_id = ?"
        )
          .bind(train.id)
          .run()
      ).rejects.toThrow("immutable")
      expect(await trainModels(env, train.id)).toEqual(frozen)
    }
  )

  it("persists the requested plan configuration even if settings change before creation commits", async () => {
    const p = testPorts(),
      network = await seedNetwork(p)
    const chosen = roleExecutions(settings("codex", "openai/gpt-6-luna"))
    const store = new NetworkStore(env.DB, chosen)
    await p.store.setNetworkModelSettings(network.id, { preset: "medium" }, at)
    const ports = {
      ...p.dispatcher,
      store,
      planner: new FakeDispatchPlanner(),
      startPlanning: async () => {},
      wakePlan: async () => {},
      retryPlan: async () => {},
    }
    const plan = await proposeDispatchPlan(ports, network.id, {
      requestId: crypto.randomUUID(),
      goal: "Plan a change",
    })
    expect((await planModels(env, plan.id)).executions).toEqual(chosen)
    await p.store.setNetworkModelSettings(network.id, null, at)
    expect((await planModels(env, plan.id)).executions).toEqual(chosen)
  })

  it("freezes Junction and incoming Train settings in their creation transaction", async () => {
    const p = testPorts(),
      network = await seedNetwork(p)
    const chosen = roleExecutions(
      settings("claude-code", "anthropic/claude-haiku-4-5-20251001")
    )
    const ports = {
      ...p.dispatcher,
      store: new NetworkStore(env.DB, chosen),
      startJunction: async () => {},
      wakeJunction: async () => {},
    }
    const junction = await layJunction(
      ports,
      network.id,
      {
        requestId: crypto.randomUUID(),
        name: "Feature",
        brief: {
          goal: "Feature",
          scope: ["src"],
          contracts: [],
          invariants: [],
          acceptanceCriteria: ["Works"],
          validation: [{ name: "test", command: ["npm", "test"] }],
        },
        incoming: ["A", "B"].map((name) => ({
          name,
          stations: [{ key: name.toLowerCase(), name, manifest: manifest() }],
        })),
        outgoing: { name: "Delivery", stations: [] },
      },
      chosen.conductor.model
    )
    expect(await p.store.executionConfig("junction", junction.id)).toEqual(
      chosen
    )
    for (const id of junction.incomingTrainIds)
      expect((await trainModels(env, id)).executions).toEqual(chosen)
    await p.store.setNetworkModelSettings(network.id, { preset: "light" }, at)
    expect(await p.store.executionConfig("junction", junction.id)).toEqual(
      chosen
    )
  })

  it("rejects review checkpoint reuse with a different harness, version or provider", async () => {
    const p = testPorts(),
      network = await seedNetwork(p)
    const { train, stations } = await seedLine(p, network.id)
    const agent = agentProvenance(executionConfig("openai/gpt-6-luna", "codex"))
    const input = {
      stationId: stations[0]!.id,
      manifest: stations[0]!.manifest,
      trainHead: train.headCommit,
      revisionCount: 0,
      proposal: {
        headCommit: "candidate",
        changedPaths: ["src/a.ts"],
        evidence: { checks: [] },
        agent,
        agentSummary: null,
      },
    }
    const verdict = {
      verdict: "accept" as const,
      summary: "Accepted",
      findings: [],
    }
    await p.store.recordConductorReview(network.id, input, agent, verdict)
    expect(await p.store.conductorReview(input, agent)).toEqual(verdict)
    for (const different of [
      { ...agent, harness: "opencode@1.18.32" },
      { ...agent, harnessVersion: "other" },
      { ...agent, provider: "anthropic" },
    ])
      await expect(p.store.conductorReview(input, different)).rejects.toThrow(
        "configuration"
      )
  })
})
