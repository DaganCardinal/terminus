import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { stopStationSandboxRequestSchema } from "@terminus/protocol"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import { handleApi } from "../api/router"
import { cleanupStationSandbox } from "./sandbox-cleanup"

async function fixture() {
  const ports = testPorts()
  const { store } = ports
  const network = await seedNetwork(ports)
  const { stations } = await seedLine(ports, network.id)
  const stationId = stations[0]!.id
  const runId = `${stationId}-s1-r0-f2`
  return {
    store,
    stationId,
    runId,
    runStatus: vi.fn(async () => "complete"),
    unpublishedCandidate: vi.fn(async () => false),
    closeSandbox: vi.fn(async () => {}),
  }
}

describe("Station Sandbox cleanup", () => {
  it.each(["complete", "errored", "terminated"])(
    "stops only the requested Sandbox for a %s Workflow without changing domain state",
    async (status) => {
      const f = await fixture()
      f.runStatus.mockResolvedValue(status)
      const before = await f.store.station(f.stationId)
      await cleanupStationSandbox(f, f.stationId, {
        runId: f.runId,
        discardUnpublishedCandidate: false,
      })
      expect(f.closeSandbox).toHaveBeenCalledWith(`station-${f.runId}`)
      expect(await f.store.station(f.stationId)).toEqual(before)
    }
  )

  it.each([
    "running",
    "queued",
    "waiting",
    "paused",
    "waitingForPause",
    "unknown",
  ])("refuses cleanup while the Workflow is %s", async (status) => {
    const f = await fixture()
    f.runStatus.mockResolvedValue(status)
    await expect(
      cleanupStationSandbox(f, f.stationId, {
        runId: f.runId,
        discardUnpublishedCandidate: true,
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(f.closeSandbox).not.toHaveBeenCalled()
  })

  it("requires explicit discard before stopping an unpublished candidate", async () => {
    const f = await fixture()
    f.unpublishedCandidate.mockResolvedValue(true)
    const request = stopStationSandboxRequestSchema.parse({ runId: f.runId })
    await expect(
      cleanupStationSandbox(f, f.stationId, request)
    ).rejects.toMatchObject({ status: 409 })
    expect(f.closeSandbox).not.toHaveBeenCalled()
    await cleanupStationSandbox(f, f.stationId, {
      ...request,
      discardUnpublishedCandidate: true,
    })
    expect(f.closeSandbox).toHaveBeenCalledWith(`station-${f.runId}`)
  })

  it("fails closed when the Workflow status cannot be verified", async () => {
    const f = await fixture()
    f.runStatus.mockRejectedValue(new Error("Workflow not found"))
    await expect(
      cleanupStationSandbox(f, f.stationId, {
        runId: f.runId,
        discardUnpublishedCandidate: true,
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(f.closeSandbox).not.toHaveBeenCalled()
  })

  it.each(["other-station-s1-r0", "station-preview", "s1-r0/../../other"])(
    "refuses an unrelated or malformed run ID: %s",
    async (runId) => {
      const f = await fixture()
      await expect(
        cleanupStationSandbox(f, f.stationId, {
          runId,
          discardUnpublishedCandidate: true,
        })
      ).rejects.toMatchObject({ status: 400 })
      expect(f.runStatus).not.toHaveBeenCalled()
      expect(f.closeSandbox).not.toHaveBeenCalled()
    }
  )

  it("validates cleanup requests and rejects unknown Stations through the API", async () => {
    const request = (body: unknown) =>
      new Request("https://terminus.test/api/stations/missing/sandbox", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await handleApi(request({ force: true }), env)).status).toBe(400)
    expect(
      (await handleApi(request({ runId: "missing-s1-r0" }), env)).status
    ).toBe(404)
  })

  it("wires the API to Workflow status and Sandbox close without configuring or starting a container", async () => {
    const f = await fixture()
    const status = vi.fn(async () => ({ status: "complete" }))
    const close = vi.fn(async () => {})
    const getByName = vi.fn(() => ({ close }))
    const cleanupEnv = {
      ...env,
      STATION_WORKFLOW: {
        get: vi.fn(async () => ({ status })),
      } as unknown as Env["STATION_WORKFLOW"],
      SANDBOX: { getByName } as unknown as Env["SANDBOX"],
    }
    const request = () =>
      new Request(`https://terminus.test/api/stations/${f.stationId}/sandbox`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: f.runId }),
      })
    expect((await handleApi(request(), cleanupEnv)).status).toBe(204)
    expect(getByName).toHaveBeenCalledWith(`station-${f.runId}`)
    expect(close).toHaveBeenCalledTimes(1)
    status.mockResolvedValue({ status: "running" })
    const response = await handleApi(request(), cleanupEnv)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Station Workflow is running"),
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
