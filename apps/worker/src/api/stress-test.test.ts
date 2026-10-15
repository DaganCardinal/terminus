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
  stressTask,
} from "@terminus/protocol"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import {
  advanceTrain,
  clearTrain,
  recordIntegrationOutcome,
  stationRunId,
} from "../workflows/train-operations"
import {
  prepareIntegration,
  promoteIntegration,
} from "../workflows/integration-operations"
import { FakeIntegrationValidator } from "../integrations/integration-validator"
import { handleApi } from "./router"
import {
  stressFindings,
  stressOracle,
  stressReport,
  stressStatus,
} from "./stress-test"
import { parseRepoId } from "@terminus/artifacts"
import { projectNamespace } from "../agents/dispatcher"
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
    // Documented limits: Artifacts namespaces have 2-63 characters and Workflow
    // instance IDs 100; repository names are held to the namespace limit.
    expect(projectNamespace(run.networkId).length).toBeLessThanOrEqual(63)
    for (const { train } of initial.trains)
      expect(parseRepoId(train.repoId).name.length).toBeLessThanOrEqual(63)
    for (const station of initial.stations)
      expect(
        stationRunId({ ...station, revisionCount: 9, runRetries: 9 }, 99).length
      ).toBeLessThanOrEqual(63)
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
      findings: [],
      warnings: [],
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
      "Car provenance: source commit unrelated is not the frozen baseline"
    )
    const noEvidence = structuredClone(snapshot)
    noEvidence.cars[0]!.evidence.checks = []
    expect(() =>
      stressOracle(noEvidence, runId, network.terminusCommit)
    ).toThrow(
      "Car lacks passing independent evidence: typecheck (missing), test (missing), build (missing)"
    )
    // A failed run still gets a report, naming each Train and failed check:
    // this ledger's scripted provenance is not what simulated execution records.
    const failed = await stressReport(env, network.id)
    expect(failed).toMatchObject({
      passed: false,
      mode: "fake",
      verification: null,
    })
    for (let train = 1; train <= 10; train++)
      expect(failed.findings).toContain(
        `Train ${train} Car provenance: Station Agent ${scriptedStressAgent.harness}/${scriptedStressAgent.model}, expected fake/fake`
      )
  })

  it("fails a run whose Station failed and was cleared, though every Train unloaded", async () => {
    const unplaced =
      "Station run failed during checkout: There is no container instance that can be provided to this Durable Object, try again later"
    const runner = new FakeStationRunner()
    let firstRun = true
    const ports = testPorts({
      runner: {
        config: { harness: "fake", model: "fake" },
        run: async (input) => {
          // Train 3's first run fails as in the first live run, which the
          // stress profile's Engineer blocks.
          if (firstRun && stressTask(input.manifest).train === 3) {
            firstRun = false
            throw new Error(unplaced)
          }
          return runner.run(input)
        },
      },
    })
    const network = await seedNetwork(ports)
    const trains = []
    for (const line of stressLines(runId))
      trains.push((await seedLine(ports, network.id, line)).train)
    await Promise.all(trains.map((train) => drive(ports, train.id)))
    expect((await ports.store.train(trains[2]!.id))!.value.state.status).toBe(
      "blocked"
    )
    await clearTrain(ports.train, trains[2]!.id)
    expect(await drive(ports, trains[2]!.id)).toEqual({
      kind: "await_terminus",
    })
    const integration = {
      store: ports.store,
      repositories: ports.train.repositories,
      validator: new FakeIntegrationValidator(),
    }
    // Train 3 joined the Terminus queue last, so it integrates last.
    for (const train of [...trains.filter((_, i) => i !== 2), trains[2]!]) {
      expect(await advanceTrain(ports.train, train.id)).toEqual({
        kind: "moved",
      })
      const attempt = await ports.store.latestIntegration(train.id)
      await prepareIntegration(integration, attempt!.input.id)
      await recordIntegrationOutcome(ports.train, train.id, {
        integrationId: attempt!.input.id,
        result: await promoteIntegration(integration, attempt!.input.id),
      })
    }
    const snapshot = (await ports.store.snapshot(network.id))!
    expect(
      snapshot.trains.every(({ train }) => train.state.status === "unloaded")
    ).toBe(true)
    // Clearing resets the Station's counters, so only the events show it.
    expect(snapshot.stations.map((station) => station.runRetries ?? 0)).toEqual(
      Array(10).fill(0)
    )
    expect(
      stressFindings(snapshot, runId, network.terminusCommit, true)
    ).toEqual([])
    const report = await stressReport(env, network.id)
    expect(report).toMatchObject({ passed: false, mode: "fake" })
    expect(report.findings).toEqual([
      `Train 3: Station run failed, blocked and cleared by intervention (Error: ${unplaced})`,
    ])
  })
})
