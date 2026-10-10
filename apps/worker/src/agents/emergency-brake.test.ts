import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { seedLine, seedNetwork, testPorts } from "../../test/fixtures"
import {
  advanceTrain,
  clearTrain,
  recordStationOutcome,
} from "../workflows/train-operations"
import {
  prepareStation,
  runStationAgent,
} from "../workflows/station-operations"
import { StaleWriteError } from "../integrations/network-store"
import { releaseHold } from "./dispatcher"
import { emergencyBrake, pullEmergencyBrake } from "./emergency-brake"
import { handleApi } from "../api/router"

async function fixture() {
  const ports = testPorts()
  const network = await seedNetwork(ports)
  const { train, stations } = await seedLine(ports, network.id)
  await advanceTrain(ports.train, train.id)
  await advanceTrain(ports.train, train.id)
  const run = ports.runs[0]!
  await prepareStation(ports.station, run)
  const stopRun = vi.fn(async () => {})
  const notifyTrain = vi.fn(async () => {})
  return {
    ports,
    network,
    train,
    stationId: stations[0]!.id,
    run,
    stopRun,
    notifyTrain,
  }
}

describe("network Emergency Brake", () => {
  it("persists a hold and stop intent before closing runs, and only the Train applies the interruption", async () => {
    const f = await fixture()
    const other = await seedNetwork(f.ports)
    const otherLine = await seedLine(f.ports, other.id)
    await advanceTrain(f.ports.train, otherLine.train.id)
    await advanceTrain(f.ports.train, otherLine.train.id)
    const before = await f.ports.store.snapshot(other.id)
    const engineer = vi.spyOn(f.ports.train.engineer, "stationFailure")
    f.notifyTrain.mockImplementation(async () => {
      expect(await f.ports.store.holds(f.network.id)).toHaveLength(1)
      expect(
        (await f.ports.store.station(f.stationId))!.value.stopRequest
      ).toBeDefined()
      expect((await f.ports.store.train(f.train.id))!.value.state.status).toBe(
        "in_transit"
      )
      await recordStationOutcome(f.ports.train, f.train.id, {
        stationId: f.stationId,
        runId: f.run.runId,
        result: {
          ok: false,
          issues: [{ kind: "station_failed", detail: "Interrupted" }],
        },
      })
    })
    const result = await pullEmergencyBrake(
      { store: f.ports.store, stopRun: f.stopRun, notifyTrain: f.notifyTrain },
      f.network.id
    )
    expect(result.failures).toEqual([])
    expect(result.cleanedUpRunIds).toEqual([f.run.runId])
    expect(f.stopRun).toHaveBeenCalledWith(f.run)
    expect(engineer).not.toHaveBeenCalled()
    expect((await f.ports.store.train(f.train.id))!.value.state.status).toBe(
      "blocked"
    )
    expect((await f.ports.store.station(f.stationId))!.value.state.status).toBe(
      "blocked"
    )
    expect(await f.ports.store.snapshot(other.id)).toEqual(before)
    await releaseHold(f.ports.dispatcher, f.network.id, result.holdId)
    await clearTrain(f.ports.train, f.train.id)
    expect(
      (await f.ports.store.station(f.stationId))!.value.stopRequest
    ).toBeUndefined()
    await advanceTrain(f.ports.train, f.train.id)
    await expect(prepareStation(f.ports.station, f.run)).rejects.toThrow(
      "no longer current"
    )
    await expect(runStationAgent(f.ports.station, f.run)).rejects.toThrow(
      "no longer current"
    )
  })

  it("blocks before starting another run and rejects Station execution after the durable stop", async () => {
    const f = await fixture()
    await pullEmergencyBrake(
      { store: f.ports.store, stopRun: f.stopRun, notifyTrain: f.notifyTrain },
      f.network.id
    )
    await expect(prepareStation(f.ports.station, f.run)).rejects.toThrow(
      "Emergency Brake"
    )
    expect(await advanceTrain(f.ports.train, f.train.id)).toEqual({
      kind: "moved",
    })
    expect((await f.ports.store.train(f.train.id))!.value.state.status).toBe(
      "blocked"
    )
    expect(f.ports.runs).toHaveLength(1)
  })

  it("retains the hold and reports individual failures, allowing repeated cleanup without duplicate commands", async () => {
    const f = await fixture()
    f.stopRun.mockRejectedValueOnce(new Error("Container unavailable"))
    const control = {
      store: f.ports.store,
      stopRun: f.stopRun,
      notifyTrain: f.notifyTrain,
    }
    const first = await pullEmergencyBrake(control, f.network.id)
    expect(first.failures).toHaveLength(1)
    const second = await pullEmergencyBrake(control, f.network.id)
    expect(second.holdId).toBe(first.holdId)
    expect(second.failures).toEqual([])
    expect(await f.ports.store.holds(f.network.id)).toHaveLength(1)
    const events = await f.ports.store.eventsAfter(f.network.id, 0)
    expect(
      events.filter(({ event }) => event.type === "station.stop_requested")
    ).toHaveLength(1)
  })

  it("retries a concurrent lifecycle write and fences pending departures", async () => {
    const f = await fixture()
    const waiting = (await f.ports.store.stations(f.network.id)).find(
      (s) => s.value.state.status === "waiting"
    )!
    const commit = vi.spyOn(f.ports.store, "commit")
    commit.mockRejectedValueOnce(new StaleWriteError())
    await pullEmergencyBrake(
      { store: f.ports.store, stopRun: f.stopRun, notifyTrain: f.notifyTrain },
      f.network.id
    )
    expect(commit).toHaveBeenCalledTimes(2)
    await expect(
      f.ports.store.commit(
        f.network.id,
        [{ kind: "station", station: waiting.value, version: waiting.version }],
        []
      )
    ).rejects.toBeInstanceOf(StaleWriteError)
  })

  it("rejects even a successful late outcome after an explicit stop", async () => {
    const f = await fixture()
    await pullEmergencyBrake(
      { store: f.ports.store, stopRun: f.stopRun, notifyTrain: f.notifyTrain },
      f.network.id
    )
    const review = vi.spyOn(f.ports.train.conductor, "review")
    await recordStationOutcome(f.ports.train, f.train.id, {
      stationId: f.stationId,
      runId: f.run.runId,
      result: {
        ok: true,
        proposal: {
          headCommit: "candidate",
          changedPaths: [],
          diff: "",
          evidence: { checks: [] },
          agent: { model: "fake", harness: "fake" },
          agentSummary: "late success",
        },
      },
    })
    expect((await f.ports.store.station(f.stationId))!.value.state.status).toBe(
      "blocked"
    )
    expect(review).not.toHaveBeenCalled()
    expect((await f.ports.store.snapshot(f.network.id))!.cars).toHaveLength(0)
  })

  it("terminates an active Workflow before closing its Sandbox and sends an explicit interruption outcome", async () => {
    const f = await fixture()
    const order: string[] = []
    let state = "running"
    const terminate = vi.fn(async () => {
      order.push("terminate")
      state = "terminated"
    })
    const close = vi.fn(async () => {
      order.push("close")
    })
    const sendEvent = vi.fn(async () => {})
    const getByName = vi.fn(() => ({ close }))
    const testEnv = {
      ...env,
      REPOSITORY_MODE: "artifacts",
      STATION_WORKFLOW: {
        get: vi.fn(async () => ({
          status: async () => ({ status: state }),
          terminate,
        })),
      } as unknown as Env["STATION_WORKFLOW"],
      TRAIN_WORKFLOW: {
        get: vi.fn(async () => ({ sendEvent })),
      } as unknown as Env["TRAIN_WORKFLOW"],
      SANDBOX: { getByName } as unknown as Env["SANDBOX"],
    }
    const result = await emergencyBrake(testEnv, f.network.id)
    expect(result.failures).toEqual([])
    expect(order).toEqual(["terminate", "close"])
    expect(getByName).toHaveBeenCalledWith(`station-${f.run.runId}`)
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          runId: f.run.runId,
          result: {
            ok: false,
            issues: [
              {
                kind: "needs_user",
                detail: expect.stringContaining("Emergency Brake"),
              },
            ],
          },
        }),
      })
    )

    const get = testEnv.STATION_WORKFLOW.get as ReturnType<typeof vi.fn>
    get.mockRejectedValueOnce(new Error("Service unavailable"))
    close.mockClear()
    expect((await emergencyBrake(testEnv, f.network.id)).failures).toHaveLength(
      1
    )
    expect(close).not.toHaveBeenCalled()
    get.mockRejectedValueOnce(new Error("Instance does not exist"))
    expect((await emergencyBrake(testEnv, f.network.id)).failures).toEqual([])
    expect(close).toHaveBeenCalledOnce()
  })

  it("requires explicit discard confirmation through the API", async () => {
    const request = (body: unknown) =>
      new Request(
        "https://terminus.test/api/networks/missing/emergency-brake",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      )
    expect(
      (await handleApi(request({ discardUnfinishedWork: false }), env)).status
    ).toBe(400)
    expect(
      (await handleApi(request({ discardUnfinishedWork: true }), env)).status
    ).toBe(404)
  })
})
