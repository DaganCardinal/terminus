// Test fixtures for the domain package. Not exported from the package index.
import { expect } from "vitest"
import type { DepartureContext } from "./engineer"
import type { Evidence } from "./evidence"
import {
  attachCar,
  arrive,
  depart,
  markReadyForPickup,
  recordWorkspace,
  startReview,
} from "./journey"
import { createLine, type Line } from "./line"
import type { WorkManifest } from "./manifest"
import { startStation, type Proposal, type Station } from "./station"
import { createTrain, type Train } from "./train"
import type { Transition, TransitionErrorCode } from "./transition"

export function unwrap<T>(transition: Transition<T>): T {
  if (!transition.ok) {
    throw new Error(`${transition.error.code}: ${transition.error.message}`)
  }
  return transition.value
}

export function expectRejected<T>(
  transition: Transition<T>,
  code: TransitionErrorCode
): void {
  expect(transition.ok).toBe(false)
  if (!transition.ok) expect(transition.error.code).toBe(code)
}

export function eventTypes<T>(transition: Transition<T>): string[] {
  return transition.ok ? transition.events.map((event) => event.type) : []
}

export function manifest(overrides: Partial<WorkManifest> = {}): WorkManifest {
  return {
    goal: "Do the thing",
    repositoryChange: {
      kind: "implementation",
      description: "Implement the requested behavior",
    },
    scope: [],
    expectedAreas: ["src/"],
    avoidAreas: [],
    contracts: [],
    invariants: [],
    dependencies: [],
    acceptanceCriteria: ["tests pass"],
    expectedEvidence: ["test"],
    ...overrides,
  }
}

export const passingEvidence: Evidence = {
  checks: [{ name: "test", required: true, status: "passed" }],
}

export const failingEvidence: Evidence = {
  checks: [{ name: "test", required: true, status: "failed" }],
}

export function clearContext(
  overrides: Partial<DepartureContext> = {}
): DepartureContext {
  return {
    holds: [],
    conflicts: [],
    trainChecks: [],
    dependencies: {},
    ...overrides,
  }
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    headCommit: "s1",
    changedPaths: ["src/a.ts"],
    evidence: passingEvidence,
    agent,
    agentSummary: null,
    ...overrides,
  }
}

export const agent = { harness: "opencode", model: "test-model" }
export const review = {
  summary: "Looks good",
  findings: [],
  model: "test-model",
}

/**
 * A Line, its Stations, and a Train at the depot. `station` is always the
 * Station the Train is working toward or at.
 */
export interface World {
  line: Line
  stations: Station[]
  train: Train
  station: Station
}

export function atDepot(stationCount = 2): World {
  const { line, stations } = unwrap(
    createLine({
      id: "red",
      networkId: "net",
      name: "Red Line",
      stations: Array.from({ length: stationCount }, (_, index) => ({
        id: `s${index + 1}`,
        name: `Station ${index + 1}`,
        manifest: manifest(),
      })),
    })
  )
  const train = unwrap(
    createTrain({ id: "t", line, repoId: "train-repo", terminusCommit: "t0" })
  )
  return { line, stations, train, station: stations[0]! }
}

export function withStation(world: World, station: Station): World {
  return {
    ...world,
    station,
    stations: world.stations.map((existing) =>
      existing.id === station.id ? station : existing
    ),
  }
}

export function inTransit(world: World = atDepot()): World {
  const departed = unwrap(depart({ ...world, context: clearContext() }))
  return withStation({ ...world, train: departed.train }, departed.station)
}

export function active(world: World = inTransit()): World {
  const withWorkspace = unwrap(
    recordWorkspace({
      ...world,
      workspace: {
        repoId: `${world.station.id}-repo`,
        baseCommit: world.train.headCommit,
      },
    })
  )
  return withStation(world, unwrap(startStation(withWorkspace)))
}

export function approaching(
  world: World = active(),
  work: Proposal = proposal({ headCommit: `${world.station.id}-head` })
): World {
  const ready = unwrap(markReadyForPickup({ ...world, proposal: work }))
  return withStation({ ...world, train: ready.train }, ready.station)
}

export function docked(world: World = approaching()): World {
  return { ...world, train: unwrap(arrive(world.train)) }
}

export function reviewing(world: World = docked()): World {
  const started = unwrap(startReview(world))
  return withStation({ ...world, train: started.train }, started.station)
}

export function accepted(world: World = reviewing()): World {
  const result = unwrap(
    attachCar({
      ...world,
      carId: `car-${world.station.id}`,
      review,
      acceptedAt: "2026-10-03T00:00:00Z",
    })
  )
  return withStation({ ...world, train: result.train }, result.station)
}
