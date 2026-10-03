import { describe, expect, it } from "vitest"
import { createLine, lineStations, nextStation } from "./line"
import { atDepot, expectRejected, manifest, unwrap } from "./testing"

const plan = (id: string, dependencies: string[] = []) => ({
  id,
  name: id,
  manifest: manifest({ dependencies }),
})

describe("createLine", () => {
  it("creates waiting Stations in travel order", () => {
    const result = createLine({
      id: "red",
      networkId: "net",
      name: "Red",
      stations: [plan("a"), plan("b", ["a"]), plan("c", ["other-line-x"])],
    })
    const { line, stations } = unwrap(result)
    expect(line.stationIds).toEqual(["a", "b", "c"])
    expect(stations.map((station) => station.state.status)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ])
    expect(stations.every((station) => station.lineId === "red")).toBe(true)
    expect(result.ok && result.events).toEqual([
      { type: "line.created", lineId: "red", stationIds: ["a", "b", "c"] },
    ])
  })

  it("rejects a Line with no Stations", () => {
    expectRejected(
      createLine({ id: "red", networkId: "net", name: "Red", stations: [] }),
      "invalid_input"
    )
  })

  it("rejects duplicate Station ids", () => {
    expectRejected(
      createLine({
        id: "red",
        networkId: "net",
        name: "Red",
        stations: [plan("a"), plan("a")],
      }),
      "invalid_input"
    )
  })

  it("rejects a dependency on a later Station of the same Line", () => {
    expectRejected(
      createLine({
        id: "red",
        networkId: "net",
        name: "Red",
        stations: [plan("a", ["b"]), plan("b")],
      }),
      "invalid_input"
    )
  })

  it("rejects a Station that depends on itself", () => {
    expectRejected(
      createLine({
        id: "red",
        networkId: "net",
        name: "Red",
        stations: [plan("a", ["a"])],
      }),
      "invalid_input"
    )
  })
})

describe("lineStations and nextStation", () => {
  it("orders Stations by the Line and skips finished ones", () => {
    const { line, stations } = atDepot(3)
    const [s1, s2, s3] = stations
    const shuffled = [s3!, s1!, s2!]
    const ordered = lineStations(line, shuffled)!
    expect(ordered.map((station) => station.id)).toEqual(["s1", "s2", "s3"])

    const progressed = [
      {
        ...s1!,
        state: { status: "complete" as const, trainId: "t", carId: "c" },
      },
      { ...s2!, state: { status: "cancelled" as const, reason: "rerouted" } },
      s3!,
    ]
    expect(nextStation(progressed)?.id).toBe("s3")
    expect(nextStation(progressed.slice(0, 2))).toBeNull()
  })

  it("returns null when a Station is missing", () => {
    const { line, stations } = atDepot(2)
    expect(lineStations(line, stations.slice(0, 1))).toBeNull()
  })
})
