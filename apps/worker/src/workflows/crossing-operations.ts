import { wakeHeldTrains } from "./train-operations"
import {
  approachCrossing,
  completeCrossing,
  evaluateCrossing,
  nextStop,
  stationCheckpoint,
  blockCrossing,
  startCrossingReview,
  holdTrain,
  releaseTrain,
  type Crossing,
  type Issue,
  type Train,
} from "@terminus/domain"
import type { IntegrationOutcome } from "@terminus/protocol"
import type { Loaded, Write } from "../integrations/network-store"
import type { AdvanceReads, TrainMove, TrainPorts } from "./train-operations"
import { applied } from "./transitions"
import { defaultValidation } from "../integrations/execution-config"

function trainWrite(loaded: Loaded<Train>, train: Train): Write {
  return { kind: "train", train, version: loaded.version }
}
async function fail(
  ports: TrainPorts,
  loaded: Loaded<Train>,
  crossing: Loaded<Crossing>,
  issues: Issue[]
): Promise<TrainMove> {
  const result = applied(blockCrossing(loaded.value, crossing.value, issues))
  await ports.store.commit(
    loaded.networkId,
    [
      trainWrite(loaded, result.value.train),
      {
        kind: "crossing",
        crossing: result.value.crossing,
        version: crossing.version,
      },
    ],
    result.events
  )
  await wakeHeldTrains(ports, loaded.networkId)
  return { kind: "moved" }
}
/** Called only by the receiving Train Workflow; it never writes the source Station. */
export async function advanceCrossing(
  ports: TrainPorts,
  loaded: Loaded<Train>,
  { line, stations, crossings }: AdvanceReads
): Promise<TrainMove | null> {
  const train = loaded.value
  if (!line) throw new Error("Train has no Line")
  const stop = nextStop(
    line,
    stations.map((s) => s.value),
    crossings
  )
  const visit =
    train.state.status === "docked" || train.state.status === "reviewing"
      ? train.state.crossingId
      : undefined
  if (!visit && stop?.kind !== "crossing") return null
  const id = visit ?? (stop?.kind === "crossing" ? stop.crossingId : undefined)
  if (!id) return null
  let crossing = await ports.store.crossing(id)
  if (!crossing) throw new Error("Missing Crossing")
  if (train.state.status === "blocked") {
    if (!crossing.value.retryRequested) return { kind: "await_clear" }
    const attempts = await ports.store.crossingAttempts(id)
    const active = attempts.find(
      (a) => a.status === "cleared" || a.status === "prepared"
    )
    if (active?.result) return { kind: "await_clear" }
    const resume = train.state.resume
    const updated: Train = active
      ? {
          ...train,
          state: {
            status: "reviewing",
            at: crossing.value.sourceStationId,
            from: resume.status === "ready" ? resume.at : { kind: "depot" },
            crossingId: id,
          },
        }
      : { ...train, state: resume }
    const c: Crossing = {
      ...crossing.value,
      retryRequested: false,
      state: active
        ? { status: "integrating", integrationId: active.input.id }
        : { status: "waiting" },
    }
    await ports.store.commit(
      loaded.networkId,
      [
        trainWrite(loaded, updated),
        { kind: "crossing", crossing: c, version: crossing.version },
      ],
      [
        { type: "train.cleared", trainId: train.id },
        {
          type: "crossing.retried",
          crossingId: id,
          trainId: train.id,
          stationId: c.sourceStationId,
        },
      ]
    )
    return { kind: "moved" }
  }
  if (train.state.status === "ready" || train.state.status === "held") {
    if (!crossing.value.checkpoint) {
      const source = stations.find(
        (s) => s.value.id === crossing!.value.sourceStationId
      )?.value
      const sourceTrain = (await ports.store.trains(loaded.networkId)).find(
        (t) => t.value.lineId === source?.lineId
      )?.value
      let checkpoint = await ports.store.checkpoint(
        crossing.value.sourceStationId
      )
      if (!checkpoint && source?.state.status === "complete" && sourceTrain) {
        checkpoint = stationCheckpoint(sourceTrain, source)
        const snapshot = await ports.store.snapshot(loaded.networkId)
        const accepted = snapshot?.cars.find(
          (c) =>
            c.id ===
            (source.state.status === "complete" ? source.state.carId : "")
        )
        if (checkpoint && accepted)
          checkpoint = { ...checkpoint, commit: accepted.acceptedCommit }
        else
          return fail(ports, loaded, crossing, [
            {
              kind: "dependency_unresolvable",
              detail: "Source checkpoint provenance is missing",
            },
          ])
      }
      if (checkpoint) {
        await ports.store.commit(
          loaded.networkId,
          [
            { kind: "checkpoint", checkpoint },
            {
              kind: "crossing",
              crossing: { ...crossing.value, checkpoint },
              version: crossing.version,
            },
          ],
          []
        )
        crossing = (await ports.store.crossing(id))!
      }
    }
    const source = stations.find(
      (s) => s.value.id === crossing!.value.sourceStationId
    )?.value
    const sourceTrain = (await ports.store.trains(loaded.networkId)).find(
      (t) => t.value.lineId === source?.lineId
    )?.value
    const context = {
      holds: await ports.store.holds(loaded.networkId),
      conflicts: await ports.store.conflicts(loaded.networkId),
      trainChecks: [],
    }
    const gate = evaluateCrossing(
      train,
      crossing.value,
      source,
      sourceTrain,
      context
    )
    if (gate.kind === "block") return fail(ports, loaded, crossing, gate.issues)
    if (gate.kind === "hold") {
      const held = applied(holdTrain(train, gate.reasons))
      if (held.events.length)
        await ports.store.commit(
          loaded.networkId,
          [trainWrite(loaded, held.value)],
          held.events
        )
      return { kind: "await_wake" }
    }
    const released =
      train.state.status === "held" ? applied(releaseTrain(train)) : null
    const next = applied(
      approachCrossing(released?.value ?? train, crossing.value, context)
    )
    await ports.store.commit(
      loaded.networkId,
      [trainWrite(loaded, next.value)],
      [...(released?.events ?? []), ...next.events]
    )
    return { kind: "moved" }
  }
  if (train.state.status === "approaching") return null // Standard arrival preserves the visit discriminator.
  if (train.state.status === "docked") {
    const checkpoint = crossing.value.checkpoint
    if (!checkpoint) throw new Error("No checkpoint at Crossing")
    const snapshot = await ports.store.snapshot(loaded.networkId)
    if (!snapshot) throw new Error("Unknown network")
    if (checkpoint.carIds.some((id) => !snapshot.cars.some((c) => c.id === id)))
      return fail(ports, loaded, crossing, [
        {
          kind: "dependency_unresolvable",
          detail: "Missing checkpoint Car provenance",
        },
      ])
    const commits = checkpoint.carIds.map((id) => {
      const car = snapshot.cars.find((c) => c.id === id)
      if (!car) throw new Error("Missing checkpoint Car")
      return car.acceptedCommit
    })
    const attemptId = `${id}-attempt-${crossing.value.attempt + 1}`
    const attempt = await ports.store.claimCrossingIntegration({
      conductorModel: ports.conductor.model,
      purpose: "crossing",
      crossingId: id,
      id: attemptId,
      networkId: loaded.networkId,
      trainId: train.id,
      trainRepoId: checkpoint.repoId,
      trainCommit: checkpoint.commit,
      trainBaseline: train.terminusBaseline,
      terminusRepoId: train.repoId,
      terminusCommit: train.headCommit,
      acceptedCommits: commits,
      validation: snapshot.network.validation ?? defaultValidation,
    })
    if (!attempt) return { kind: "await_wake" }
    const started = applied(
      startCrossingReview(train, crossing.value, attemptId)
    )
    await ports.store.commit(
      loaded.networkId,
      [
        trainWrite(loaded, started.value.train),
        {
          kind: "crossing",
          crossing: started.value.crossing,
          version: crossing.version,
        },
      ],
      started.events
    )
    return { kind: "moved" }
  }
  if (
    train.state.status === "reviewing" &&
    crossing.value.state.status === "integrating"
  ) {
    const attempt = await ports.store.integration(
      crossing.value.state.integrationId
    )
    if (!attempt) throw new Error("Crossing has no attempt")
    if (attempt.result) {
      await recordCrossingOutcome(ports, train.id, {
        integrationId: attempt.input.id,
        result: attempt.result,
      })
      return { kind: "moved" }
    }
    await ports.startIntegration(attempt.input.id)
    return { kind: "await_integration", integrationId: attempt.input.id }
  }
  return null
}
export async function recordCrossingOutcome(
  ports: TrainPorts,
  trainId: string,
  outcome: IntegrationOutcome
): Promise<void> {
  const loaded = await ports.store.train(trainId),
    attempt = await ports.store.integration(outcome.integrationId)
  if (
    !loaded ||
    !attempt ||
    attempt.input.purpose !== "crossing" ||
    !attempt.input.crossingId
  )
    return
  const crossing = await ports.store.crossing(attempt.input.crossingId)
  if (
    !crossing ||
    crossing.value.state.status !== "integrating" ||
    crossing.value.state.integrationId !== outcome.integrationId ||
    !attempt.result
  )
    return
  if (
    loaded.value.state.status !== "reviewing" ||
    loaded.value.state.crossingId !== crossing.value.id ||
    loaded.value.headCommit !== attempt.input.terminusCommit
  )
    return
  const result = attempt.result
  if (!result.ok) {
    if (result.holds) {
      // No promotion occurred: return to the same pickup gate and retry after release.
      const next: Train = {
        ...loaded.value,
        state: { status: "ready", at: loaded.value.state.from },
      }
      const held = applied(holdTrain(next, result.holds))
      await ports.store.commit(
        loaded.networkId,
        [
          trainWrite(loaded, held.value),
          {
            kind: "crossing",
            crossing: { ...crossing.value, state: { status: "waiting" } },
            version: crossing.version,
          },
        ],
        held.events
      )
    } else await fail(ports, loaded, crossing, result.issues)
    return
  }
  if (
    attempt.status !== "completed" ||
    attempt.review?.verdict !== "accept" ||
    attempt.candidate?.headCommit !== result.mergeCommit
  )
    throw new Error("Crossing result has no accepted durable candidate")
  const snapshot = await ports.store.snapshot(loaded.networkId)
  if (!snapshot) throw new Error("Unknown network")
  const completed = applied(
    completeCrossing(
      loaded.value,
      crossing.value,
      snapshot.cars,
      snapshot.cars.filter((c) => c.trainId === trainId),
      result.mergeCommit,
      ports.now(),
      {
        evidence: result.evidence,
        expectedChecks: attempt.input.validation.map((c) => c.name),
        verdict: attempt.review.verdict,
      }
    )
  )
  await ports.store.commit(
    loaded.networkId,
    [
      trainWrite(loaded, completed.value.train),
      {
        kind: "crossing",
        crossing: completed.value.crossing,
        version: crossing.version,
      },
      ...completed.value.cars.map((car): Write => ({ kind: "car", car })),
    ],
    completed.events
  )
}
