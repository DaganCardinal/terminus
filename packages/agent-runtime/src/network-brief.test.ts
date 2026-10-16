import { describe, expect, it } from "vitest"
import type { NetworkSnapshot } from "@terminus/protocol"
import type { Line, Station, Train, WorkManifest } from "@terminus/domain"
import { buildNetworkBrief } from "./network-brief"

const manifest = (goal: string): WorkManifest => ({
  goal,
  scope: ["scope"],
  expectedAreas: ["src/app.ts"],
  avoidAreas: [],
  contracts: [],
  invariants: ["stays working"],
  dependencies: [],
  acceptanceCriteria: ["works"],
  expectedEvidence: ["test"],
})
const line = (id: string, stations: string[]): Line => ({
  id,
  networkId: "n",
  name: `${id} Line`,
  stationIds: stations,
})
const station = (
  id: string,
  lineId: string,
  status: Station["state"]["status"]
): Station =>
  ({
    id,
    lineId,
    name: `Station ${id}`,
    manifest: manifest(`Goal of ${id}\nsecond line`),
    revisionCount: 0,
    state: { status },
  }) as Station
const view = (train: Train, at = "2026-10-16T12:00:00.000Z") => ({
  train,
  signal: null,
  stateEnteredAt: at,
  previous: null,
})
const train = (id: string, lineId: string, state: Train["state"]): Train =>
  ({
    id,
    lineId,
    repoId: "r",
    terminusBaseline: "c",
    headCommit: "c",
    carIds: [],
    state,
  }) as unknown as Train

function snapshot(lines: number): NetworkSnapshot {
  const quiet = Array.from({ length: lines }, (_, i) => `q${i}`)
  return {
    network: {
      id: "n",
      name: "Demo",
      terminusRepoId: "ns/terminus",
      terminusCommit: "abc",
      createdAt: "2026-10-16T11:00:00.000Z",
    },
    lines: [
      line("blocked", ["b1"]),
      line("done", ["d1"]),
      ...quiet.map((id) => line(id, [`${id}-1`, `${id}-2`])),
    ],
    lineCreatedAt: {},
    stations: [
      station("b1", "blocked", "blocked"),
      station("d1", "done", "complete"),
      ...quiet.flatMap((id) => [
        station(`${id}-1`, id, "complete"),
        station(`${id}-2`, id, "waiting"),
      ]),
    ],
    trains: [
      view(
        train("t-blocked", "blocked", {
          status: "blocked",
          issues: [{ kind: "station_failed", detail: "Tests failed\nmore" }],
          resume: { status: "ready", at: { kind: "station", stationId: "b1" } },
        })
      ),
      view(
        train("t-done", "done", { status: "unloaded", mergeCommit: "m" }),
        "2026-10-16T12:30:00.000Z"
      ),
      ...quiet.map((id) =>
        view(
          train(`t-${id}`, id, {
            status: "in_transit",
            from: { kind: "depot" },
            toward: `${id}-2`,
          })
        )
      ),
    ],
    cars: [],
    holds: [],
    conflicts: [],
    plans: [],
    lastSeq: 1,
  }
}

describe("buildNetworkBrief", () => {
  it("leads with what needs attention and says where each Station's work is", () => {
    const brief = buildNetworkBrief(snapshot(1), "2026-10-16T13:00:00.000Z")
    expect(brief.network).toEqual({
      name: "Demo",
      terminusCommit: "abc",
      asOf: "2026-10-16T13:00:00.000Z",
    })
    expect(brief.attention.blockedTrains).toEqual([
      {
        trainId: "t-blocked",
        line: "blocked Line",
        stationId: "b1",
        issues: ["station_failed: Tests failed"],
      },
    ])
    const quiet = brief.liveLines.find((l) => l.id === "q0")!
    expect(quiet).toMatchObject({
      number: 3,
      color: "green",
      destination: "terminus",
      train: { status: "in_transit", at: "travelling toward q0-2" },
      stations: [
        { id: "q0-1", where: "on_train", goal: "Goal of q0-1" },
        { id: "q0-2", where: "waiting" },
      ],
    })
    expect(brief.finishedLines).toEqual([
      {
        name: "done Line",
        outcome: "integrated",
        finishedAt: "2026-10-16T12:30:00.000Z",
        stations: ["Station d1"],
      },
    ])
  })

  it("shrinks quiet Lines to counts when over budget, never those needing attention", () => {
    const brief = buildNetworkBrief(snapshot(30), "now", 6_000)
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(6_000)
    expect(brief.liveLines.find((l) => l.id === "blocked")).toHaveProperty(
      "stations"
    )
    expect(
      brief.liveLines.filter((l) => "summary" in l).length
    ).toBeGreaterThan(0)
    expect(brief.liveLines.find((l) => "summary" in l)).toMatchObject({
      number: expect.any(Number),
      color: expect.any(String),
      summary: "2 Stations: 1 on_train, 1 waiting",
    })
  })
})
