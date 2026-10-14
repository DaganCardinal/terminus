import { describe, expect, it } from "vitest"
import type { Line, PlanningContext, Station } from "@terminus/domain"
import { dispatcherSystemPrompt, promptNetwork } from "./dispatcher-agent"

const line = (id: string): Line => ({
  id,
  networkId: "n",
  name: `${id} Line`,
  stationIds: [`${id}-s`],
})
const station = (lineId: string): Station =>
  ({
    id: `${lineId}-s`,
    lineId,
    name: `${lineId} Station`,
    manifest: { goal: `${lineId} goal` },
    revisionCount: 0,
    state: { status: "complete" },
  }) as unknown as Station

const network = (finished: string[], live: string[]): PlanningContext => ({
  projectChecks: [{ name: "test", command: ["npm", "test"] }],
  activeLines: [],
  lines: [...finished, ...live].map(line),
  stations: [...finished, ...live].map(station),
  crossings: [],
  junctions: [],
  finishedLines: finished.map((lineId, i) => ({
    lineId,
    outcome: i % 2 ? "abandoned" : "integrated",
  })),
})

describe("promptNetwork", () => {
  it("sends live Lines in full and summarizes finished ones", () => {
    const view = promptNetwork(network(["red", "blue"], ["green"]))
    expect(view.lines.map((l) => l.id)).toEqual(["green"])
    expect(view.stations.map((s) => s.id)).toEqual(["green-s"])
    expect(view.finishedLines).toEqual([
      { name: "red Line", outcome: "integrated", stations: ["red Station"] },
      { name: "blue Line", outcome: "abandoned", stations: ["blue Station"] },
    ])
    expect(view).not.toHaveProperty("olderFinishedLines")
  })

  it("keeps the prompt bounded as finished Lines accumulate", () => {
    const finished = Array.from({ length: 200 }, (_, i) => `old${i}`)
    const view = promptNetwork(network(finished, ["green"]))
    expect(view.finishedLines).toHaveLength(30)
    expect(view.finishedLines[0]!.name).toBe("old0 Line")
    expect(view.olderFinishedLines).toBe(170)
    const prompt = dispatcherSystemPrompt({
      network: network(finished, ["green"]),
      baseline: null,
    })
    expect(prompt).not.toContain("old199 goal")
    expect(prompt).toContain("green goal")
  })

  it("sends everything when nothing has finished", () => {
    const context = network([], ["red", "blue"])
    expect(promptNetwork(context)).toMatchObject({
      lines: context.lines,
      stations: context.stations,
      finishedLines: [],
    })
  })
})
