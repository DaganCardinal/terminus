import { SELF } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import {
  FakeConflictInvestigator,
  FakeConflictTriage,
  type ConflictInvestigationInput,
  type ConflictInvestigator,
} from "@terminus/agent-runtime"
import { conflictWatchId } from "@terminus/domain"
import {
  drive,
  manifest,
  runStation,
  seedLine,
  seedNetwork,
  testPorts,
} from "../../test/fixtures"
import {
  investigateConflict,
  pendingConflictPairs,
  triageConflict,
  watchNewCars,
  type ConflictWatchPorts,
} from "./conflict-watch-operations"
import {
  advanceTrain,
  recordStationOutcome,
  reviewStation,
} from "./train-operations"

/** Three Lines: two change the same file, a third works next to it. */
async function setup(stationCount = 1) {
  const ports = testPorts()
  const started: string[] = []
  const train = {
    ...ports.train,
    startConflictWatch: async (watchId: string) => {
      started.push(watchId)
    },
  }
  const network = await seedNetwork(ports)
  const line = (name: string, area: string) =>
    seedLine(ports, network.id, {
      name,
      stations: Array.from({ length: stationCount }, (_, index) => ({
        key: index ? `s-${index}` : "s",
        name: `${name} Station ${index + 1}`,
        manifest: manifest({
          expectedAreas: [index ? "src/api/permissions.ts" : area],
        }),
      })),
    })
  const auth = await line("Auth", "src/api/login.ts")
  const profile = await line("Profile", "src/api/login.ts")
  const session = await line("Session", "src/api/session.ts")
  const investigator = new FakeConflictInvestigator()
  const watch: ConflictWatchPorts = {
    store: ports.store,
    triage: new FakeConflictTriage(),
    investigator,
    now: () => new Date().toISOString(),
  }
  return {
    ports,
    train,
    started,
    network,
    auth,
    profile,
    session,
    watch,
    investigator,
  }
}

const carOf = async (w: Awaited<ReturnType<typeof setup>>, trainId: string) =>
  (await w.ports.store.trainCars(trainId))[0]!

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Stop immediately after the next acceptance, before the next Station starts. */
async function acceptNextCar(
  w: Awaited<ReturnType<typeof setup>>,
  trainId: string
) {
  const count = (await w.ports.store.trainCars(trainId)).length
  for (let leg = 0; leg < 30; leg++) {
    const move = await advanceTrain(w.ports.train, trainId)
    if (move.kind === "review") await reviewStation(w.ports.train, trainId)
    else if (move.kind === "await_station") {
      const run = w.ports.runs.find((run) => run.runId === move.runId)!
      await recordStationOutcome(
        w.ports.train,
        trainId,
        await runStation(w.ports, run)
      )
    } else if (move.kind !== "moved")
      throw new Error(`Train stopped before accepting a Car: ${move.kind}`)
    const cars = await w.ports.store.trainCars(trainId)
    if (cars.length > count)
      return cars.find((car) => car.position === count + 1)!
  }
  throw new Error("Train did not accept its next Car")
}

describe("Dispatcher conflict watch", () => {
  it("retains unwatched Cars when persistence fails and screens them on retry", async () => {
    const w = await setup()
    await drive(w.ports, w.auth.train.id)
    const car = await carOf(w, w.auth.train.id)
    const save = vi.spyOn(w.ports.store.conflictWatch, "save")
    save.mockRejectedValueOnce(new Error("D1 temporarily unavailable"))

    await expect(watchNewCars(w.train, w.auth.train.id)).rejects.toThrow(
      "D1 temporarily unavailable"
    )
    expect(
      await w.ports.store.conflictWatch.unwatchedCars(w.auth.train.id)
    ).toEqual([car])

    await watchNewCars(w.train, w.auth.train.id)
    expect(w.started).toEqual([conflictWatchId(car.id)])
    expect(
      await w.ports.store.conflictWatch.unwatchedCars(w.auth.train.id)
    ).toEqual([])
  })

  it("retains failed dispatches, starts other watches and retries with the same identity", async () => {
    const w = await setup(2)
    await drive(w.ports, w.auth.train.id)
    const before = (await w.ports.store.train(w.auth.train.id))!.value
    const ids = (await w.ports.store.trainCars(w.auth.train.id)).map((car) =>
      conflictWatchId(car.id)
    )
    const start = vi.spyOn(w.train, "startConflictWatch")
    start.mockRejectedValueOnce(new Error("Workflow creation unavailable"))

    await expect(watchNewCars(w.train, w.auth.train.id)).rejects.toThrow(
      "Conflict watch dispatch deferred"
    )
    expect(start.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining(ids)
    )
    expect(start).toHaveBeenCalledTimes(ids.length)
    const failed = start.mock.calls[0]![0]
    const successful = start.mock.calls[1]![0]
    expect(w.started).toEqual([successful])
    expect(
      (await w.ports.store.conflictWatch.watch(failed))?.value.pairs
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "investigate" }),
      ])
    )

    await watchNewCars(w.train, w.auth.train.id)
    expect(start.mock.calls.slice(ids.length).map(([id]) => id)).toEqual(
      expect.arrayContaining(ids)
    )
    expect(start).toHaveBeenCalledTimes(ids.length * 2)
    expect((await w.ports.store.train(w.auth.train.id))!.value).toEqual(before)
  })

  it("checks newer heads when Cars arrive during an investigation that clears older work", async () => {
    const w = await setup(2)
    await acceptNextCar(w, w.profile.train.id)
    const oldCar = await acceptNextCar(w, w.auth.train.id)
    const oldId = conflictWatchId(oldCar.id)
    await watchNewCars(w.train, w.auth.train.id)

    const entered = deferred<ConflictInvestigationInput>()
    const finish = deferred<void>()
    const investigator = vi.spyOn(w.investigator, "investigate")
    investigator.mockImplementationOnce(async (input) => {
      entered.resolve(input)
      await finish.promise
      return {
        trialMerge: { clean: true, conflictPaths: [] },
        verdict: {
          conflict: false,
          summary: "The earlier changes are compatible.",
          paths: [],
          details: [],
          suggestedHold: "none",
        },
      }
    })
    const earlier = investigateConflict(w.watch, oldId, w.profile.train.id)
    const oldInput = await entered.promise
    try {
      const theirNewer = await acceptNextCar(w, w.profile.train.id)
      await watchNewCars(w.train, w.profile.train.id)
      const newer = await acceptNextCar(w, w.auth.train.id)
      await watchNewCars(w.train, w.auth.train.id)
      const newId = conflictWatchId(newer.id)
      expect(w.started).toContain(conflictWatchId(theirNewer.id))
      expect(w.started).toContain(newId)
      expect(
        (await pendingConflictPairs(w.watch, newId)).investigate
      ).toContain(w.profile.train.id)

      finish.resolve(undefined)
      await earlier
      expect(
        (await w.ports.store.conflictWatch.watch(oldId))!.value.pairs
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            otherTrainId: w.profile.train.id,
            stage: "dismissed",
          }),
        ])
      )

      await investigateConflict(w.watch, newId, w.profile.train.id)
      const newInput = investigator.mock.calls.at(-1)![0]
      expect(newInput.repositories.train.commit).not.toBe(
        oldInput.repositories.train.commit
      )
      expect(newInput.repositories.other.commit).not.toBe(
        oldInput.repositories.other.commit
      )
      const pair = (await w.ports.store.conflictWatch.watch(
        newId
      ))!.value.pairs.find((pair) => pair.otherTrainId === w.profile.train.id)
      expect(pair).toMatchObject({
        stage: "confirmed",
        investigation: { finding: { paths: ["src/api/permissions.ts"] } },
      })
    } finally {
      finish.resolve(undefined)
      await earlier
    }
  })

  it("screens a new Car, triages the gray zone, investigates and reports", async () => {
    const w = await setup()
    // Profile and Session accept their Cars first; nothing to compare yet.
    await drive(w.ports, w.profile.train.id)
    await drive(w.ports, w.session.train.id)
    await drive(w.ports, w.auth.train.id)
    const authCar = await carOf(w, w.auth.train.id)
    const id = conflictWatchId(authCar.id)

    await watchNewCars(w.train, w.auth.train.id)
    expect(w.started).toEqual([id])
    // A second leg records nothing new and starts the same pending watch.
    await watchNewCars(w.train, w.auth.train.id)
    expect(w.started).toEqual([id, id])
    expect(await pendingConflictPairs(w.watch, id)).toEqual({
      triage: [w.session.train.id],
      investigate: [w.profile.train.id],
    })

    // Clef (simulated) finds Session related: same directory, no shared file.
    await triageConflict(w.watch, id, w.session.train.id)
    expect(await pendingConflictPairs(w.watch, id)).toEqual({
      triage: [],
      investigate: [w.profile.train.id, w.session.train.id],
    })
    let snapshot = (await w.ports.store.snapshot(w.network.id))!
    expect(snapshot.conflictConcerns?.map((c) => c.pair.stage)).toEqual([
      "investigate",
      "investigate",
    ])

    const investigate = vi.spyOn(
      w.investigator as ConflictInvestigator,
      "investigate"
    )
    await investigateConflict(w.watch, id, w.profile.train.id)
    await investigateConflict(w.watch, id, w.session.train.id)
    // Replaying a finished step does nothing.
    await investigateConflict(w.watch, id, w.profile.train.id)
    expect(investigate).toHaveBeenCalledTimes(2)
    expect(investigate.mock.calls[0]![0].repositories.other.repoId).toBe(
      w.profile.train.repoId
    )

    snapshot = (await w.ports.store.snapshot(w.network.id))!
    expect(snapshot.conflictConcerns).toEqual([
      expect.objectContaining({
        watchId: id,
        trainId: w.auth.train.id,
        pair: expect.objectContaining({
          otherTrainId: w.profile.train.id,
          stage: "confirmed",
          investigation: expect.objectContaining({
            finding: expect.objectContaining({
              paths: ["src/api/login.ts"],
              suggestedHold: w.auth.train.id,
            }),
          }),
        }),
      }),
    ])
    const types = (await w.ports.store.eventsAfter(w.network.id, 0))
      .map((row) => row.event.type)
      .filter((type) => type.startsWith("dispatcher.conflict"))
    expect(types).toEqual([
      "dispatcher.conflict_investigating",
      "dispatcher.conflict_investigating",
      "dispatcher.conflict_reported",
      "dispatcher.conflict_cleared",
    ])

    const url = `https://terminus.test/api/networks/${w.network.id}/conflict-watches/${id}/${w.profile.train.id}/acknowledge`
    expect((await SELF.fetch(url, { method: "POST" })).status).toBe(200)
    expect((await SELF.fetch(url, { method: "POST" })).status).toBe(200)
    expect(
      (
        await SELF.fetch(url.replace(w.network.id, "wrong"), {
          method: "POST",
        })
      ).status
    ).toBe(404)
    snapshot = (await w.ports.store.snapshot(w.network.id))!
    expect(snapshot.conflictConcerns).toEqual([])

    // Nothing is left to start once every pair is settled.
    w.started.length = 0
    await watchNewCars(w.train, w.auth.train.id)
    expect(w.started).toEqual([])
  })

  it("compares a Car with Stations other Lines still plan before they have Cars", async () => {
    const w = await setup()
    await drive(w.ports, w.auth.train.id)
    await watchNewCars(w.train, w.auth.train.id)
    const authCar = await carOf(w, w.auth.train.id)
    const watch = await w.ports.store.conflictWatch.watch(
      conflictWatchId(authCar.id)
    )
    expect(watch?.value.pairs.map((pair) => pair.route)).toEqual([
      "overlap",
      "triage",
    ])
    expect(w.started).toHaveLength(1)
  })

  it("skips a pair whose other Train already left the network", async () => {
    const w = await setup()
    await drive(w.ports, w.profile.train.id)
    await drive(w.ports, w.auth.train.id)
    await watchNewCars(w.train, w.auth.train.id)
    const id = conflictWatchId((await carOf(w, w.auth.train.id)).id)
    const other = (await w.ports.store.train(w.profile.train.id))!
    await w.ports.store.commit(
      w.network.id,
      [
        {
          kind: "train",
          train: {
            ...other.value,
            state: { status: "siding", reason: "Abandoned" },
          } as never,
          version: other.version,
        },
      ],
      []
    )
    await investigateConflict(w.watch, id, w.profile.train.id)
    const watch = (await w.ports.store.conflictWatch.watch(id))!.value
    expect(
      watch.pairs.find((p) => p.otherTrainId === w.profile.train.id)?.stage
    ).toBe("skipped")
  })
})
