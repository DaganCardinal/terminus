import { describe, expect, it } from "vitest"
import type { Line } from "@terminus/domain"
import { lineIdentities, type LineHistory } from "./line-identity"

const line = (id: string, extra: Partial<Line> = {}): Line =>
  ({
    id,
    networkId: "n",
    name: `${id} Line`,
    stationIds: [`${id}-s1`],
    ...extra,
  }) as Line
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 10, 12, minute)).toISOString()
const train = (lineId: string, status: string, minute = 0) => ({
  train: { lineId, state: { status } },
  stateEnteredAt: at(minute),
})
const history = (
  lines: [Line, number][],
  trains: LineHistory["trains"],
  extra: Partial<LineHistory> = {}
): LineHistory => ({
  network: { createdAt: at(0) },
  lines: lines.map(([l]) => l),
  lineCreatedAt: Object.fromEntries(lines.map(([l, m]) => [l.id, at(m)])),
  trains,
  ...extra,
})

describe("lineIdentities", () => {
  it("gives concurrent Lines distinct slots and colours", () => {
    const ids = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 1],
          [line("c"), 1],
        ],
        [train("a", "in_transit"), train("b", "ready"), train("c", "held")]
      )
    )
    expect([...ids.values()].map((i) => [i.slot, i.color, i.live])).toEqual([
      [0, 0, true],
      [1, 1, true],
      [2, 2, true],
    ])
  })

  it("returns a finished Line's slot, colour and shape to the next Line", () => {
    const ids = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 1],
          [line("c"), 10],
        ],
        [
          train("a", "unloaded", 5),
          train("b", "in_transit"),
          train("c", "ready", 10),
        ]
      )
    )
    const a = ids.get("a")!
    expect(a).toMatchObject({ live: false, finishedAt: at(5) })
    expect(ids.get("b")).toMatchObject({ slot: 1, live: true })
    expect(ids.get("c")).toMatchObject({
      slot: a.slot,
      color: a.color,
      live: true,
    })
  })

  it("keeps a live Line's identity when an earlier Line finishes", () => {
    const before = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 2],
        ],
        [train("a", "in_transit"), train("b", "in_transit")]
      )
    )
    const after = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 2],
        ],
        [train("a", "siding", 3), train("b", "in_transit")]
      )
    )
    expect(after.get("b")).toEqual(before.get("b"))
  })

  it("starts a new generation only once every Line has finished", () => {
    const ids = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 1],
          [line("c"), 6],
          [line("d"), 20],
        ],
        [
          train("a", "unloaded", 5),
          train("b", "unloaded", 10),
          train("c", "siding", 15),
          train("d", "ready", 20),
        ]
      )
    )
    expect([...ids.values()].map((i) => i.generation)).toEqual([0, 0, 0, 1])
  })

  it("does not reuse a slot freed after the new Line was laid", () => {
    const ids = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 2],
        ],
        [train("a", "unloaded", 3), train("b", "in_transit")]
      )
    )
    expect(ids.get("b")!.slot).toBe(1)
  })

  it("keeps Lines joined by a Crossing until all of them finish", () => {
    const source = line("a")
    const receiver = line("b", {
      stops: [
        { kind: "crossing", stationId: "a-s1", crossingId: "x" },
        { kind: "station", stationId: "b-s1" },
      ],
    } as Partial<Line>)
    const ids = lineIdentities(
      history(
        [
          [source, 1],
          [receiver, 1],
          [line("c"), 10],
        ],
        [
          train("a", "unloaded", 5),
          train("b", "in_transit"),
          train("c", "ready"),
        ]
      )
    )
    expect(ids.get("a")!.live).toBe(true)
    expect(ids.get("c")!.slot).toBe(2)
  })

  it("keeps a Junction's Lines together until the outgoing Line unloads", () => {
    const into = { kind: "junction", junctionId: "j" } as const
    const lines: [Line, number][] = [
      [line("a", { destination: into }), 1],
      [line("b", { destination: into }), 1],
      [line("out", { origin: into, stationIds: [] }), 1],
    ]
    const collecting = lineIdentities(
      history(lines, [train("a", "unloaded", 4), train("b", "in_transit")])
    )
    expect([...collecting.values()].every((i) => i.live)).toBe(true)
    const done = lineIdentities(
      history(lines, [
        train("a", "unloaded", 4),
        train("b", "unloaded", 5),
        train("out", "unloaded", 9),
      ])
    )
    expect([...done.values()].map((i) => i.finishedAt)).toEqual([
      at(9),
      at(9),
      at(9),
    ])
  })

  it("leaves named colours to the Lines named after them", () => {
    const ids = lineIdentities(
      history(
        [
          [line("x", { name: "Auth" }), 1],
          [line("r", { name: "Red Line" }), 1],
          [line("b", { name: "Blue Line" }), 1],
        ],
        []
      )
    )
    expect(ids.get("r")!.color).toBe(0)
    expect(ids.get("b")!.color).toBe(1)
    expect(ids.get("x")!.color).toBe(2)
  })

  it("predicts planned Lines without reusing live identities", () => {
    const ids = lineIdentities(
      history(
        [
          [line("a"), 1],
          [line("b"), 1],
        ],
        [train("a", "unloaded", 2), train("b", "in_transit")]
      ),
      [
        { id: "p1", name: "Planned" },
        { id: "p2", name: "Planned" },
      ]
    )
    expect(ids.get("p1")!.slot).toBe(0)
    expect(ids.get("p2")!.slot).toBe(2)
  })
})
