// Shared fixtures for Worker tests. Ports run against the test D1 database,
// with Station runs and Train wakes recorded instead of started.
import {
  FakeConductor,
  FakeEngineer,
  FakeStationRunner,
  type Conductor,
  type EngineerAdvisor,
  type StationRunner,
} from "@terminus/agent-runtime"
import { FakeRepositoryHost } from "@terminus/artifacts"
import type { TrainId, WorkManifest } from "@terminus/domain"
import type { LayLineRequest, StationOutcome } from "@terminus/protocol"
import { env } from "cloudflare:test"
import {
  createNetwork,
  layLine,
  type DispatcherPorts,
} from "../src/agents/dispatcher"
import { NetworkStore } from "../src/integrations/network-store"
import {
  prepareStation,
  runStationAgent,
  type StationPorts,
} from "../src/workflows/station-operations"
import {
  advanceTrain,
  failReview,
  recordStationOutcome,
  reviewStation,
  type StationRunParams,
  type TrainMove,
  type TrainPorts,
} from "../src/workflows/train-operations"

export interface TestPorts {
  store: NetworkStore
  train: TrainPorts
  station: StationPorts
  dispatcher: DispatcherPorts
  /** Every Station run the Train asked to start, in order. */
  runs: StationRunParams[]
  wakes: TrainId[]
}

export function testPorts(
  roles: {
    runner?: StationRunner
    conductor?: Conductor
    engineer?: EngineerAdvisor
  } = {}
): TestPorts {
  const store = new NetworkStore(env.DB)
  const repositories = new FakeRepositoryHost()
  const runs: StationRunParams[] = []
  const wakes: TrainId[] = []
  const newId = (prefix: string) =>
    `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  const now = () => new Date().toISOString()
  return {
    store,
    runs,
    wakes,
    train: {
      store,
      repositories,
      conductor: roles.conductor ?? new FakeConductor(),
      engineer: roles.engineer ?? new FakeEngineer(),
      stationMaxRetries: 3,
      startStationRun: async (params) => {
        if (!runs.some((run) => run.runId === params.runId)) runs.push(params)
      },
      startIntegration: async () => {},
      wakeTrain: async (trainId) => {
        wakes.push(trainId)
      },
      newId,
      now,
    },
    station: {
      store,
      repositories,
      runner: roles.runner ?? new FakeStationRunner(),
    },
    dispatcher: {
      store,
      repositories,
      startTrain: async () => {},
      wakeTrain: async (trainId) => {
        wakes.push(trainId)
      },
      clearTrain: async () => {},
      notifyTrainCommand: async (trainId) => {
        wakes.push(trainId)
      },
      retryIntegration: async () => {},
      newId,
      now,
    },
  }
}

/**
 * Does what the Train and Station Workflows do, synchronously: advances the
 * Train and runs each Station it waits on, until the Train must wait on
 * something else.
 */
export async function drive(
  ports: TestPorts,
  trainId: TrainId,
  limit = 60
): Promise<TrainMove> {
  for (let step = 0; step < limit; step++) {
    const train = await ports.store.train(trainId)
    if (
      train?.value.state.status === "returning" &&
      train.value.state.phase === "awaiting_clearance"
    )
      return { kind: "await_terminus" }
    const move = await advanceTrain(ports.train, trainId)
    if (move.kind === "moved") continue
    if (move.kind === "review") {
      await reviewStation(ports.train, trainId).catch(() =>
        failReview(ports.train, trainId)
      )
      continue
    }
    if (move.kind !== "await_station") return move

    const run = ports.runs.find((started) => started.runId === move.runId)
    if (!run) throw new Error(`Run ${move.runId} was never started`)
    await recordStationOutcome(
      ports.train,
      trainId,
      await runStation(ports, run)
    )
  }
  throw new Error(`Train ${trainId} did not settle`)
}

export async function runStation(
  ports: TestPorts,
  run: StationRunParams
): Promise<StationOutcome> {
  try {
    await prepareStation(ports.station, run)
    const result = await runStationAgent(ports.station, run)
    return { stationId: run.stationId, runId: run.runId, result }
  } catch (error) {
    return {
      stationId: run.stationId,
      runId: run.runId,
      result: {
        ok: false,
        issues: [{ kind: "station_failed", detail: String(error) }],
      },
    }
  }
}

export function manifest(overrides: Partial<WorkManifest> = {}): WorkManifest {
  return {
    goal: "Do the thing",
    repositoryChange: {
      kind: "implementation",
      description: "Implement the requested behavior",
    },
    scope: [],
    expectedAreas: ["src/thing.ts"],
    avoidAreas: [],
    contracts: [],
    invariants: [],
    dependencies: [],
    acceptanceCriteria: [],
    expectedEvidence: [],
    ...overrides,
  }
}

export function twoStationLine(name = "Red Line"): LayLineRequest {
  return {
    name,
    stations: [
      { key: "a", name: "A", manifest: manifest() },
      { key: "b", name: "B", manifest: manifest({ dependencies: ["a"] }) },
    ],
  }
}

export async function seedNetwork(ports: TestPorts) {
  return createNetwork(ports.dispatcher, { name: "Test network" })
}

export async function seedLine(
  ports: TestPorts,
  networkId: string,
  request: LayLineRequest = twoStationLine()
) {
  return layLine(ports.dispatcher, networkId, request)
}
