import { describe, expect, it } from "vitest"
import type { Line, NetworkSnapshot, TrainView } from "@terminus/protocol"
import { planningContext } from "./dispatch-planning"
import { defaultValidation } from "../integrations/execution-config"

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 10, 12, minute)).toISOString()
const line = (id: string, extra: Partial<Line> = {}): Line => ({
  id,
  networkId: "n",
  name: id,
  stationIds: [`${id}-s`],
  ...extra,
})
const train = (lineId: string, status: string, minute: number) =>
  ({
    train: { id: `${lineId}-t`, lineId, state: { status } },
    stateEnteredAt: at(minute),
  }) as unknown as TrainView
const snapshot = (
  lines: Line[],
  trains: TrainView[],
  extra: Partial<NetworkSnapshot> = {}
) =>
  ({
    network: { createdAt: at(0) },
    lines,
    lineCreatedAt: Object.fromEntries(lines.map((l) => [l.id, at(1)])),
    stations: [],
    trains,
    junctions: [],
    crossings: [],
    ...extra,
  }) as unknown as NetworkSnapshot

describe("planningContext", () => {
  it("checks plans against the network's configured project checks", () => {
    const lint = { name: "lint", command: ["npm", "run", "lint"] }
    const configured = snapshot([], [], {
      network: { createdAt: at(0), validation: [lint] },
    } as unknown as Partial<NetworkSnapshot>)
    expect(planningContext(configured).projectChecks).toEqual([lint])
    expect(planningContext(snapshot([], [])).projectChecks).toEqual(
      defaultValidation
    )
  })

  it("lists finished Lines, most recent first, with their outcome", () => {
    const context = planningContext(
      snapshot(
        [line("red"), line("blue"), line("green")],
        [
          train("red", "unloaded", 5),
          train("blue", "siding", 7),
          train("green", "in_transit", 2),
        ]
      )
    )
    expect(context.finishedLines).toEqual([
      { lineId: "blue", outcome: "abandoned" },
      { lineId: "red", outcome: "integrated" },
    ])
    expect(context.lines).toHaveLength(3)
  })

  it("keeps work collected in an unreleased Junction live", () => {
    const into = { kind: "junction", junctionId: "j" } as const
    const context = planningContext(
      snapshot(
        [
          line("a", { destination: into }),
          line("b", { destination: into }),
          line("out", { origin: into, stationIds: [] }),
        ],
        [train("a", "unloaded", 4), train("b", "unloaded", 5)],
        {
          junctions: [
            { id: "j", outgoingLineId: "out", state: { status: "ready" } },
          ] as unknown as NetworkSnapshot["junctions"],
        }
      )
    )
    expect(context.finishedLines).toEqual([])
    expect(context.activeLines.map((l) => l.name)).toEqual(["a", "b", "out"])
  })

  it("leaves work already in Terminus out of collision forecasts", () => {
    const context = planningContext(
      snapshot(
        [
          line("source"),
          line("receiver", {
            stops: [
              { kind: "crossing", stationId: "source-s", crossingId: "x" },
              { kind: "station", stationId: "receiver-s" },
            ],
          }),
          line("dropped"),
          line("taker", {
            stops: [
              { kind: "crossing", stationId: "dropped-s", crossingId: "y" },
              { kind: "station", stationId: "taker-s" },
            ],
          }),
        ],
        [
          train("source", "unloaded", 3),
          train("receiver", "in_transit", 2),
          train("dropped", "siding", 3),
          train("taker", "in_transit", 2),
        ]
      )
    )
    expect(context.activeLines.map((l) => l.name)).toEqual([
      "receiver",
      "dropped",
      "taker",
    ])
  })
})
