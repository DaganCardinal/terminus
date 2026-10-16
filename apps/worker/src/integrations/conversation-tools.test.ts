import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  seedLine,
  seedNetwork,
  testPorts,
  twoStationLine,
} from "../../test/fixtures"
import { ConversationStore } from "./conversation-store"
import { ConversationToolRunner } from "./conversation-tools"

const runner = (networkId: string) =>
  new ConversationToolRunner({
    db: env.DB,
    store: testPorts().store,
    conversations: new ConversationStore(env.DB),
    networkId,
  })

describe("the Dispatcher's read tools", () => {
  it("answer only about the turn's own network", async () => {
    const ports = testPorts()
    const mine = await seedNetwork(ports)
    const theirs = await seedNetwork(ports)
    const { line, stations, train } = await seedLine(ports, mine.id)
    const other = await seedLine(ports, theirs.id, twoStationLine("Blue Line"))

    const station = JSON.parse(
      await runner(mine.id).run("terminus_station", {
        stationId: stations[0]!.id,
      })
    )
    expect(station).toMatchObject({
      id: stations[0]!.id,
      line: "Red Line",
      where: "waiting",
      manifest: { goal: "Do the thing" },
    })
    expect(
      JSON.parse(
        await runner(mine.id).run("terminus_station", {
          stationId: other.stations[0]!.id,
        })
      )
    ).toEqual({ error: `No Station ${other.stations[0]!.id} in this network` })
    expect(
      JSON.parse(
        await runner(mine.id).run("terminus_line", { lineId: other.line.id })
      )
    ).toHaveProperty("error")

    const route = JSON.parse(
      await runner(mine.id).run("terminus_line", { lineId: line.id })
    )
    expect(route).toMatchObject({ number: 1, color: "red" })
    expect(route.trains[0]).toMatchObject({ id: train.id })
    expect(
      route.route.map((stop: { station: string }) => stop.station)
    ).toEqual(["A", "B"])

    const activity = JSON.parse(
      await runner(mine.id).run("terminus_activity", { entityId: train.id })
    )
    expect(activity.events.length).toBeGreaterThan(0)
    expect(
      JSON.parse(
        await runner(mine.id).run("terminus_activity", {
          entityId: other.train.id,
        })
      ).events
    ).toEqual([])

    const found = JSON.parse(
      await runner(mine.id).run("terminus_search", { query: "do the" })
    )
    expect(found.stations).toHaveLength(2)
  })

  it("answers a malformed call with a problem the model can fix", async () => {
    const network = await seedNetwork(testPorts())
    expect(
      JSON.parse(
        await runner(network.id).run("terminus_activity", {
          entityId: "x",
          limit: 500,
        })
      )
    ).toHaveProperty("error")
    expect(
      JSON.parse(await runner(network.id).run("terminus_plan", "{not json"))
    ).toEqual({ error: "The arguments are not valid JSON." })
  })
})
