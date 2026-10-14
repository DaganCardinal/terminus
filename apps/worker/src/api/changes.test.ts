import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  repositoryChangesSchema,
  repositoryChangeFileSchema,
} from "@terminus/protocol"
import { handleApi } from "./router"
import { drive, seedLine, seedNetwork, testPorts } from "../../test/fixtures"

const get = (path: string) =>
  handleApi(new Request(`https://terminus.test/api${path}`), env)

async function setup() {
  const p = testPorts()
  const network = await seedNetwork(p)
  const { train } = await seedLine(p, network.id)
  await drive(p, train.id)
  const loaded = (await p.store.train(train.id))!.value
  const cars = await p.store.trainCars(train.id)
  return { p, network, train: loaded, cars }
}

describe("accepted changes API", () => {
  it("reads Train and Car commit pairs on demand without writing any domain records", async () => {
    const { p, network, train, cars } = await setup()
    const before = await p.store.snapshot(network.id)
    const query = new URLSearchParams({
      base: train.terminusBaseline,
      head: train.headCommit,
    })
    const response = await get(`/trains/${train.id}/changes?${query}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toContain("private")
    const changes = repositoryChangesSchema.parse(await response.json())
    expect(changes).toMatchObject({
      base: train.terminusBaseline,
      head: train.headCommit,
    })
    expect(changes.files).toHaveLength(1)
    for (const car of cars) {
      const query = new URLSearchParams({
        base: car.sourceCommit,
        head: car.acceptedCommit,
      })
      const response = await get(
        `/trains/${train.id}/cars/${car.id}/changes?${query}`
      )
      expect(response.status).toBe(200)
      const result = repositoryChangesSchema.parse(await response.json())
      expect(result).toMatchObject({
        base: car.sourceCommit,
        head: car.acceptedCommit,
      })
      query.set("path", result.files[0]!.path)
      const file = await get(
        `/trains/${train.id}/cars/${car.id}/changes/file?${query}`
      )
      expect(file.status).toBe(200)
      expect(repositoryChangeFileSchema.parse(await file.json())).toMatchObject(
        { status: "text", base: car.sourceCommit, head: car.acceptedCommit }
      )
    }
    query.set("path", changes.files[0]!.path)
    expect(
      (await get(`/trains/${train.id}/changes/file?${query}`)).status
    ).toBe(200)
    expect(await p.store.snapshot(network.id)).toEqual(before)
  })

  it("rejects unrecorded snapshots, Cars from other Trains, invalid paths and missing files", async () => {
    const { p, network, train, cars } = await setup()
    const other = await seedLine(p, network.id)
    const query = new URLSearchParams({
      base: cars[0]!.sourceCommit,
      head: cars[0]!.acceptedCommit,
    })
    expect(
      (
        await get(
          `/trains/${other.train.id}/cars/${cars[0]!.id}/changes?${query}`
        )
      ).status
    ).toBe(404)
    query.set("head", "unrecorded")
    expect((await get(`/trains/${train.id}/changes?${query}`)).status).toBe(409)
    expect((await get(`/trains/${train.id}/changes`)).status).toBe(400)
    query.set("head", train.headCommit)
    query.set("base", train.terminusBaseline)
    expect((await get(`/trains/unknown/changes?${query}`)).status).toBe(404)
    query.set("path", "../.env")
    expect(
      (await get(`/trains/${train.id}/changes/file?${query}`)).status
    ).toBe(400)
    for (const path of [".env", "not-changed.txt"]) {
      query.set("path", path)
      expect(
        (await get(`/trains/${train.id}/changes/file?${query}`)).status
      ).toBe(404)
    }
  })

  it("shows an empty comparison before any accepted work", async () => {
    const p = testPorts(),
      network = await seedNetwork(p)
    const { train } = await seedLine(p, network.id)
    const query = new URLSearchParams({
      base: train.terminusBaseline,
      head: train.headCommit,
    })
    const response = await get(`/trains/${train.id}/changes?${query}`)
    expect(repositoryChangesSchema.parse(await response.json())).toMatchObject({
      files: [],
      filesTruncated: false,
    })
  })
})
