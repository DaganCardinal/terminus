import { describe, expect, it } from "vitest"
import type { Car } from "./car"
import {
  acknowledgeConflictPair,
  activeConflictConcerns,
  concludeConflictInvestigation,
  conflictTriageLikely,
  failConflictInvestigation,
  screenCar,
  skipConflictPair,
  startConflictWatch,
  triageConflictPair,
  watchableCar,
  type ConflictInvestigation,
} from "./conflict-watch"
import type { Station } from "./station"
import type { Train } from "./train"
import { manifest } from "./testing"

const train = (id: string, lineId: string, status = "in_transit"): Train =>
  ({
    id,
    lineId,
    repoId: `repo-${id}`,
    terminusBaseline: "base",
    headCommit: `head-${id}`,
    carIds: [],
    state:
      status === "unloaded"
        ? { status: "unloaded", commit: "c" }
        : { status: "in_transit", from: { kind: "depot" }, toward: "s" },
  }) as unknown as Train

const car = (
  id: string,
  trainId: string,
  changedPaths: string[],
  overrides: Partial<Car> = {}
): Car => ({
  id,
  trainId,
  stationId: `station-${id}`,
  position: 1,
  manifest: manifest(),
  stationAgent: { harness: "fake", model: "fake" },
  sourceCommit: "a",
  acceptedCommit: "b",
  changedPaths,
  evidence: { checks: [] },
  agentSummary: null,
  review: { summary: "ok", findings: [], model: "fake" },
  acceptedAt: "2026-10-13T00:00:00.000Z",
  ...overrides,
})

const station = (
  id: string,
  lineId: string,
  expectedAreas: string[],
  status: "waiting" | "complete" = "waiting"
): Station =>
  ({
    id,
    lineId,
    name: id,
    manifest: manifest({ expectedAreas }),
    revisionCount: 0,
    state:
      status === "complete"
        ? { status: "complete", trainId: "t", carId: "c" }
        : { status: "waiting" },
  }) as Station

const a = train("a", "line-a")
const b = train("b", "line-b")
const c = train("c", "line-c")
const newCar = car("car-a", "a", ["src/api/login.ts", "src/ui/form.tsx"])

function screen(cars: Car[], stations: Station[] = [], trains = [a, b, c]) {
  return screenCar({ car: newCar, train: a, trains, cars, stations })
}

describe("screening", () => {
  it("sends shared files straight to investigation", () => {
    const [pair] = screen([newCar, car("car-b", "b", ["src/api/login.ts"])])
    expect(pair).toMatchObject({
      otherTrainId: "b",
      route: "overlap",
      stage: "investigate",
      overlap: { sharedPaths: ["src/api/login.ts"] },
    })
  })

  it("sends areas another Line still plans to change to investigation", () => {
    const [pair] = screen([newCar], [station("s-b", "line-b", ["src/api/"])])
    expect(pair).toMatchObject({
      route: "overlap",
      overlap: {
        sharedPaths: [],
        plannedAreas: [{ stationId: "s-b", paths: ["src/api/login.ts"] }],
      },
    })
  })

  it("asks Clef about related Trains, closest first, and skips Trains with nothing to compare", () => {
    const pairs = screen([
      newCar,
      car("car-b", "b", ["docs/readme.md"]),
      car("car-c", "c", ["src/api/session.ts"]),
    ])
    expect(pairs.map((pair) => [pair.otherTrainId, pair.stage])).toEqual([
      ["c", "triage"],
      ["b", "triage"],
    ])
    expect(pairs[0]!.overlap.sharedDirectories).toEqual(["src/api"])
    expect(screen([newCar])).toEqual([])
  })

  it("caps the Trains Clef is asked about", () => {
    const pairs = screenCar({
      car: newCar,
      train: a,
      trains: [a, b, c],
      cars: [newCar, car("b1", "b", ["x/y"]), car("c1", "c", ["x/z"])],
      stations: [],
      maxTriage: 1,
    })
    expect(pairs).toHaveLength(1)
  })

  it("ignores finished Trains, the Car's own Line and finished Stations", () => {
    const pairs = screen(
      [
        newCar,
        car("car-u", "u", ["src/api/login.ts"]),
        car("car-a2", "a2", ["src/api/login.ts"]),
      ],
      [station("done", "line-b", ["src/"], "complete")],
      [a, train("u", "line-u", "unloaded"), train("a2", "line-a")]
    )
    expect(pairs).toEqual([])
  })

  it("does not compare a Train with copies of the Car's own Train's work", () => {
    const copy = car("copy", "b", ["src/api/login.ts"], {
      originCarId: "car-a",
      sourceCarId: "car-a",
      copiedAt: "now",
    })
    expect(screen([newCar, copy])).toEqual([])
    expect(watchableCar(copy)).toBe(false)
    expect(watchableCar(newCar)).toBe(true)
  })

  it("leaves out Trains with an unacknowledged report with this one", () => {
    const other = car("car-b", "b", ["src/api/login.ts"])
    const earlier = startConflictWatch({
      car: other,
      train: b,
      at: "t0",
      pairs: screenCar({
        car: other,
        train: b,
        trains: [a, b],
        cars: [other, car("car-a0", "a", ["src/api/login.ts"])],
        stations: [],
      }),
    }).watch
    const reported = concludeConflictInvestigation(
      earlier,
      a.id,
      {
        model: "m",
        commits: { train: "b0", other: "a0" },
        trialMerge: { clean: false, conflictPaths: ["src/api/login.ts"] },
        summary: "The trial merge conflicts.",
      },
      "t1"
    ).watch
    const concerns = activeConflictConcerns([reported], [a, b, c])
    expect(concerns).toHaveLength(1)
    expect(
      screenCar({
        car: newCar,
        train: a,
        trains: [a, b],
        cars: [newCar, other],
        stations: [],
        concerns,
      })
    ).toEqual([])
  })

  it.each(["own", "other"])(
    "screens newer Cars while an investigation belongs to the %s Train",
    (owner) => {
      const oldCar = car("a0", "a", ["src/old.ts"])
      const otherCar = car("b0", "b", ["src/old.ts"])
      const watched = owner === "own" ? oldCar : otherCar
      const watchedTrain = owner === "own" ? a : b
      const earlier = startConflictWatch({
        car: watched,
        train: watchedTrain,
        at: "t0",
        pairs: screenCar({
          car: watched,
          train: watchedTrain,
          trains: [a, b],
          cars: [oldCar, otherCar],
          stations: [],
        }),
      }).watch
      const newer = car("a1", "a", ["src/new.ts"])
      const theirNewer = car("b1", "b", ["src/new.ts"])
      const [pair] = screenCar({
        car: newer,
        train: a,
        trains: [a, b],
        cars: [oldCar, otherCar, newer, theirNewer],
        stations: [],
        concerns: activeConflictConcerns([earlier], [a, b]),
      })
      expect(pair).toMatchObject({
        otherTrainId: "b",
        stage: "investigate",
        overlap: { sharedPaths: ["src/new.ts"] },
      })
    }
  )

  it("records shared contracts", () => {
    const contract = { name: "POST /login", kind: "api", change: "modify" }
    const withContract = car("car-a", "a", ["src/x.ts"], {
      manifest: manifest({ contracts: [contract] as never }),
    })
    const [pair] = screenCar({
      car: withContract,
      train: a,
      trains: [a, b],
      cars: [
        withContract,
        car("car-b", "b", ["lib/y.ts"], {
          manifest: manifest({ contracts: [contract] as never }),
        }),
      ],
      stations: [],
    })
    expect(pair!.overlap.sharedContracts).toEqual(["api: POST /login"])
  })
})

describe("watch lifecycle", () => {
  const started = startConflictWatch({
    car: newCar,
    train: a,
    at: "t0",
    pairs: screen([
      newCar,
      car("car-b", "b", ["src/api/login.ts"]),
      car("car-c", "c", ["src/api/session.ts"]),
    ]),
  })
  const investigation = (
    overrides: Partial<ConflictInvestigation> = {}
  ): ConflictInvestigation => ({
    model: "m",
    commits: { train: "x", other: "y" },
    trialMerge: { clean: true, conflictPaths: [] },
    summary: "Both change the login handler signature.",
    finding: {
      kind: "semantic",
      summary: "Both change the login handler signature.",
      paths: ["src/api/login.ts"],
      details: [],
    },
    ...overrides,
  })

  it("announces investigations only for pairs that need one", () => {
    expect(started.watch.id).toBe("watch-car-a")
    expect(started.events).toEqual([
      expect.objectContaining({
        type: "dispatcher.conflict_investigating",
        otherTrainId: "b",
        route: "overlap",
      }),
    ])
  })

  it("moves likely triage to investigation and dismisses the rest", () => {
    const likely = triageConflictPair(started.watch, "c", {
      likely: true,
      probability: 0.8,
      model: "clef",
    })
    expect(likely.watch.pairs[1]!.stage).toBe("investigate")
    expect(likely.events.map((e) => e.type)).toEqual([
      "dispatcher.conflict_investigating",
    ])
    const unlikely = triageConflictPair(started.watch, "c", {
      likely: false,
      probability: null,
      model: "clef",
      error: "timeout",
    })
    expect(unlikely.watch.pairs[1]).toMatchObject({
      stage: "dismissed",
      reason: "Clef gave no answer, and the Lines share no files",
    })
    expect(unlikely.events).toEqual([])
    // Only a pair waiting for triage takes an answer.
    expect(
      triageConflictPair(started.watch, "b", {
        likely: false,
        probability: 0,
        model: "clef",
      }).watch
    ).toBe(started.watch)
    expect(conflictTriageLikely(0.5)).toBe(false)
    expect(conflictTriageLikely(0.51)).toBe(true)
    expect(conflictTriageLikely(null)).toBe(false)
  })

  it("reports a finding, then lets the user acknowledge it", () => {
    const reported = concludeConflictInvestigation(
      started.watch,
      "b",
      investigation(),
      "t1"
    )
    expect(reported.watch.pairs[0]).toMatchObject({
      stage: "confirmed",
      reportedAt: "t1",
    })
    expect(reported.events).toEqual([
      expect.objectContaining({
        type: "dispatcher.conflict_reported",
        paths: ["src/api/login.ts"],
      }),
    ])
    const acknowledged = acknowledgeConflictPair(reported.watch, "b", "t2")
    expect(acknowledged.watch.pairs[0]!.acknowledgedAt).toBe("t2")
    expect(
      acknowledgeConflictPair(acknowledged.watch, "b", "t3").events
    ).toEqual([])
  })

  it("reports a conflicted trial merge even when the model saw no conflict", () => {
    const { watch } = concludeConflictInvestigation(
      started.watch,
      "b",
      investigation({
        trialMerge: { clean: false, conflictPaths: ["src/api/login.ts"] },
        finding: undefined,
      }),
      "t1"
    )
    expect(watch.pairs[0]).toMatchObject({
      stage: "confirmed",
      investigation: {
        finding: { kind: "textual", paths: ["src/api/login.ts"] },
      },
    })
  })

  it("clears, fails or skips pairs without reporting them", () => {
    const cleared = concludeConflictInvestigation(
      started.watch,
      "b",
      investigation({ finding: undefined, summary: "Independent changes." }),
      "t1"
    )
    expect(cleared.watch.pairs[0]).toMatchObject({
      stage: "dismissed",
      reason: "Independent changes.",
    })
    expect(cleared.events.map((e) => e.type)).toEqual([
      "dispatcher.conflict_cleared",
    ])
    expect(
      failConflictInvestigation(started.watch, "b", "Sandbox capacity").watch
        .pairs[0]!.stage
    ).toBe("failed")
    expect(
      skipConflictPair(started.watch, "c", "finished").pairs[1]!.stage
    ).toBe("skipped")
  })

  it("shows running checks and unacknowledged reports while both Trains run", () => {
    const reported = concludeConflictInvestigation(
      started.watch,
      "b",
      investigation(),
      "t1"
    ).watch
    expect(
      activeConflictConcerns([started.watch], [a, b, c]).map(
        (concern) => concern.pair.stage
      )
    ).toEqual(["investigate"])
    expect(activeConflictConcerns([reported], [a, b, c])).toEqual([
      expect.objectContaining({
        watchId: "watch-car-a",
        lineId: "line-a",
        pair: expect.objectContaining({ stage: "confirmed" }),
      }),
    ])
    expect(
      activeConflictConcerns([reported], [a, train("b", "line-b", "unloaded")])
    ).toEqual([])
    expect(
      activeConflictConcerns(
        [acknowledgeConflictPair(reported, "b", "t2").watch],
        [a, b]
      )
    ).toEqual([])
  })
})
