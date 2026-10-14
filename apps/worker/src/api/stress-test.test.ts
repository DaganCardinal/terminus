import {
  env,
  introspectWorkflow,
  type WorkflowIntrospector,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FakeConductor,
  FakeStationRunner,
  FakeConflictTriage,
  FakeConflictInvestigator,
  ModelConflictTriage,
  HarnessConflictInvestigator,
} from "@terminus/agent-runtime"
import {
  PIPELINE_STRESS_PROFILE,
  scriptedStressAgent,
  stressLines,
} from "@terminus/protocol"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import {
  advanceTrain,
  recordIntegrationOutcome,
} from "../workflows/train-operations"
import {
  prepareIntegration,
  promoteIntegration,
} from "../workflows/integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import { handleApi } from "./router"
import { stressOracle, stressStatus } from "./stress-test"
import { NetworkStore } from "../integrations/network-store"
import { trainModels, conflictWatchPorts } from "../agents/ports"

const runId = "00000000-0000-4000-8000-000000000005"
const profileEnv = {
  ...env,
  REPOSITORY_MODE: "artifacts",
}
describe("pipeline stress profile", () => {
  let introspectors: WorkflowIntrospector[] = []
  beforeEach(async () => {
    introspectors = await Promise.all([
      introspectWorkflow(env.TRAIN_WORKFLOW),
      introspectWorkflow(env.STATION_WORKFLOW),
      introspectWorkflow(env.INTEGRATION_WORKFLOW),
      introspectWorkflow(env.CONFLICT_WATCH_WORKFLOW),
    ])
  })
  afterEach(async () => {
    await Promise.all(introspectors.map((instance) => instance.dispose()))
  })
  it("offers the browser flow without a global mode switch and refuses fixture injection through ordinary commands", async () => {
    expect(
      (
        await handleApi(
          new Request("https://terminus.test/api/stress-test"),
          env
        )
      ).status
    ).toBe(200)
    const body = stressLines(runId)[0]!
    expect(
      (
        await handleApi(
          new Request("https://terminus.test/api/networks/n/lines", {
            method: "POST",
            body: JSON.stringify(body),
          }),
          env
        )
      ).status
    ).toBe(409)
  })
  it("creates and verifies ten real local Workflows with one idempotent browser command", async () => {
    const requestId = crypto.randomUUID()
    const launch = () =>
      handleApi(
        new Request("https://terminus.test/api/stress-tests", {
          method: "POST",
          body: JSON.stringify({ requestId }),
        }),
        env
      )
    const response = await launch()
    expect(response.status).toBe(201)
    const run = (await response.json()) as { networkId: string; runId: string }
    expect((await launch()).status).toBe(201)
    const store = new NetworkStore(env.DB)
    const initial = (await store.snapshot(run.networkId))!
    expect(initial.trains).toHaveLength(10)
    expect(initial.lines).toHaveLength(10)
    const liveRoleEnv = {
      ...profileEnv,
      ENGINEER_MODEL: "live",
      DISPATCHER_MODEL: "live",
      // Constructor-only regression check; no real service is contacted.
      ARTIFACTS_ACCOUNT_ID: "unused-test-account",
      ARTIFACTS_API_TOKEN: "unused-test-token",
    }
    const frozen = await trainModels(env, initial.trains[0]!.train.id)
    const scriptedWatch = conflictWatchPorts(liveRoleEnv, frozen)
    expect(scriptedWatch.triage).toBeInstanceOf(FakeConflictTriage)
    expect(scriptedWatch.investigator).toBeInstanceOf(FakeConflictInvestigator)
    const ordinaryWatch = conflictWatchPorts(liveRoleEnv, {
      ...frozen,
      executions: { ...frozen.executions!, pipelineStress: undefined },
    })
    expect(ordinaryWatch.triage).toBeInstanceOf(ModelConflictTriage)
    expect(ordinaryWatch.investigator).toBeInstanceOf(
      HarnessConflictInvestigator
    )
    for (const { train } of initial.trains) {
      expect(
        (await trainModels(env, train.id)).executions?.pipelineStress
      ).toBe(PIPELINE_STRESS_PROFILE)
    }
    const deadline = Date.now() + 20_000
    while (
      (await store.snapshot(run.networkId))!.trains.some(
        ({ train }) => train.state.status !== "unloaded"
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("Ten-Train Workflow rehearsal did not drain")
      await scheduler.wait(50)
    }
    const report = await handleApi(
      new Request(
        `https://terminus.test/api/networks/${run.networkId}/stress-test/report`,
        { method: "POST" }
      ),
      env
    )
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({
      passed: true,
      mode: "fake",
      verification: null,
      status: { completedIntegrations: 10 },
      timings: { findings: [] },
    })
    const ordinary = await seedNetwork(testPorts())
    const normal = await seedLine(testPorts(), ordinary.id)
    expect(
      (await trainModels(env, normal.train.id)).executions?.pipelineStress
    ).toBeUndefined()
  }, 30_000)

  it("drains ten ordinary Trains through the offline D1 ledger and rejects broken provenance", async () => {
    const runner = new FakeStationRunner()
    const conductor = new FakeConductor()
    // Only this ledger test substitutes repositories/evidence. The live profile never does.
    const ports = testPorts({
      runner: {
        config: scriptedStressAgent,
        run: async (input) => {
          const result = await runner.run(input)
          return result.ok
            ? {
                ...result,
                proposal: { ...result.proposal, agent: scriptedStressAgent },
              }
            : result
        },
      },
      conductor: {
        config: scriptedStressAgent,
        model: scriptedStressAgent.model,
        review: (input) => conductor.review(input),
      },
    })
    const network = await seedNetwork(ports)
    const trains = []
    for (const line of stressLines(runId))
      trains.push((await seedLine(ports, network.id, line)).train)
    await Promise.all(trains.map((train) => drive(ports, train.id)))
    const integration = {
      store: ports.store,
      repositories: ports.train.repositories,
      validator: new FakeIntegrationValidator(),
    }
    for (const train of trains) {
      expect(await advanceTrain(ports.train, train.id)).toEqual({
        kind: "moved",
      })
      const attempt = await ports.store.latestIntegration(train.id)
      await prepareIntegration(integration, attempt!.input.id)
      const result = await promoteIntegration(integration, attempt!.input.id)
      await recordIntegrationOutcome(ports.train, train.id, {
        integrationId: attempt!.input.id,
        result,
      })
    }
    const snapshot = (await ports.store.snapshot(network.id))!
    const oracle = stressOracle(snapshot, runId, network.terminusCommit)
    expect(Object.keys(oracle.files)).toHaveLength(20)
    expect(oracle.acceptedCommits).toHaveLength(10)
    expect(await stressStatus(profileEnv, network.id)).toMatchObject({
      leases: 0,
      activeIntegrations: 0,
      completedIntegrations: 10,
      failedIntegrations: 0,
    })
    const corrupt = structuredClone(snapshot)
    corrupt.cars[0]!.sourceCommit = "unrelated"
    expect(() => stressOracle(corrupt, runId, network.terminusCommit)).toThrow(
      "provenance"
    )
    const noEvidence = structuredClone(snapshot)
    noEvidence.cars[0]!.evidence.checks = []
    expect(() =>
      stressOracle(noEvidence, runId, network.terminusCommit)
    ).toThrow("independent evidence")
  })
})
