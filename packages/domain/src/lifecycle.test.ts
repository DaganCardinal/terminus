import { describe, expect, it } from "vitest"
import type { DomainEvent } from "./events"
import {
  arrive,
  attachCar,
  depart,
  markReadyForPickup,
  recordWorkspace,
  returnToStation,
  startReview,
} from "./journey"
import { startStation } from "./station"
import { beginReturn, clearForTerminus, completeIntegration } from "./terminus"
import {
  atDepot,
  clearContext,
  passingEvidence,
  proposal,
  review,
  unwrap,
  withStation,
  type World,
} from "./testing"
import type { Transition } from "./transition"

describe("a Train's full journey", () => {
  it("runs two Stations, with one revision, and unloads into Terminus", () => {
    const log: DomainEvent[] = []
    function run<T>(transition: Transition<T>): T {
      const value = unwrap(transition)
      if (transition.ok) log.push(...transition.events)
      return value
    }

    let world: World = atDepot(2)

    for (const stationId of ["s1", "s2"]) {
      const departed = run(depart({ ...world, context: clearContext() }))
      world = withStation({ ...world, train: departed.train }, departed.station)
      expect(world.station.id).toBe(stationId)

      world = withStation(
        world,
        run(
          recordWorkspace({
            ...world,
            workspace: {
              repoId: `${stationId}-repo`,
              baseCommit: world.train.headCommit,
            },
          })
        )
      )
      world = withStation(world, run(startStation(world.station)))

      const ready = run(
        markReadyForPickup({
          ...world,
          proposal: proposal({ headCommit: `${stationId}-v1` }),
        })
      )
      world = withStation({ ...world, train: ready.train }, ready.station)
      world = { ...world, train: run(arrive(world.train)) }

      let reviewed = run(startReview(world))
      world = withStation({ ...world, train: reviewed.train }, reviewed.station)

      if (stationId === "s1") {
        const returned = run(
          returnToStation({
            ...world,
            feedback: { summary: "Add a test", findings: [] },
          })
        )
        world = withStation(
          { ...world, train: returned.train },
          returned.station
        )
        const revised = run(
          markReadyForPickup({
            ...world,
            proposal: proposal({ headCommit: `${stationId}-v2` }),
          })
        )
        world = withStation({ ...world, train: revised.train }, revised.station)
        reviewed = run(startReview(world))
        world = withStation(
          { ...world, train: reviewed.train },
          reviewed.station
        )
      }

      const attached = run(
        attachCar({
          ...world,
          carId: `car-${stationId}`,
          review,
          acceptedAt: "2026-10-03T00:00:00Z",
        })
      )
      world = withStation({ ...world, train: attached.train }, attached.station)
    }

    // The second Station was forked from the Train after the first Car.
    expect(
      log.find(
        (event) =>
          event.type === "station.workspace_created" && event.stationId === "s2"
      )
    ).toMatchObject({ baseCommit: "s1-v2" })
    expect(world.train.carIds).toEqual(["car-s1", "car-s2"])
    expect(world.train.headCommit).toBe("s2-v1")

    let train = run(beginReturn(world))
    train = run(clearForTerminus({ train, context: clearContext() }))
    train = run(
      completeIntegration({
        train,
        mergeCommit: "merge",
        evidence: passingEvidence,
        conflicts: [],
      })
    )
    expect(train.state).toEqual({ status: "unloaded", mergeCommit: "merge" })

    const stationLeg = [
      "train.departed",
      "station.signaled",
      "station.workspace_created",
      "station.started",
      "station.ready_for_pickup",
      "train.approaching",
      "train.arrived",
      "review.started",
    ]
    expect(log.map((event) => event.type)).toEqual([
      ...stationLeg,
      "station.returned",
      "station.ready_for_pickup",
      "review.started",
      "car.attached",
      ...stationLeg,
      "car.attached",
      "train.returning",
      "terminus.integration_requested",
      "terminus.integration_started",
      "terminus.integration_completed",
      "train.unloaded",
    ])
  })
})
