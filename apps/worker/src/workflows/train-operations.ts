import type { Conductor, ReviewInput } from "@terminus/agent-runtime"
import { RepositoryMovedError, type RepositoryHost } from "@terminus/artifacts"
import {
  arrive,
  attachCar,
  beginReturn,
  clearForTerminus,
  completeIntegration,
  deferIntegration,
  detectConflict,
  blockStation,
  blockTrain,
  clearTrainBlock,
  depart,
  evaluateDeparture,
  evaluateTerminusEntry,
  unmetRequiredChecks,
  holdTrain,
  markReadyForPickup,
  nextStation,
  releaseTrain,
  resetStation,
  returnToStation,
  startReview,
  type DepartureContext,
  type GateDecision,
  type Issue,
  type Line,
  type NetworkId,
  type ReviewFeedback,
  type Station,
  type StationId,
  type Train,
  type TrainId,
} from "@terminus/domain"
import {
  conductorVerdictSchema,
  type ConductorVerdict,
  type StationOutcome,
  type IntegrationOutcome,
} from "@terminus/protocol"
import { requestTerminusClearance } from "../agents/dispatcher"
import type { Loaded, NetworkStore, Write } from "../integrations/network-store"
import { applied, TransitionRejectedError } from "./transitions"

export interface StationRunParams {
  trainId: TrainId
  stationId: StationId
  runId: string
}

export interface TrainPorts {
  store: NetworkStore
  repositories: RepositoryHost
  conductor: Conductor
  /** Starts a Station run. Starting a run that already exists does nothing. */
  startStationRun(params: StationRunParams): Promise<void>
  startIntegration(integrationId: string): Promise<void>
  /** Asks a held Train to evaluate its gate again. */
  wakeTrain(trainId: TrainId): Promise<void>
  newId(prefix: string): string
  now(): string
}

/** What the Train Workflow does after a step. */
export type TrainMove =
  | { kind: "moved" }
  | { kind: "await_station"; runId: string }
  | { kind: "await_wake" }
  | { kind: "await_clear" }
  | { kind: "await_terminus" }
  | { kind: "await_integration"; integrationId: string }
  | { kind: "finished"; status: "unloaded" | "siding" }

/**
 * Identifies one run of a Station: each signal starts a fresh workspace, and
 * each revision is another run on the same workspace.
 */
export function stationRunId(station: Station, signalCount: number): string {
  return `${station.id}-s${signalCount}-r${station.revisionCount}`
}

/**
 * Makes the Train's next move from its persisted state: one transition, or
 * the event to wait for. Safe to repeat, because it always starts from what
 * is stored.
 */
export async function advanceTrain(
  ports: TrainPorts,
  trainId: TrainId
): Promise<TrainMove> {
  const loaded = await loadTrain(ports, trainId)
  const { state } = loaded.value
  switch (state.status) {
    case "ready":
      return departOrReturn(ports, loaded)
    case "in_transit":
      return awaitStation(ports, trainId, state.toward)
    case "approaching": {
      const arrived = applied(arrive(loaded.value))
      await ports.store.commit(
        loaded.networkId,
        [trainWrite(loaded, arrived.value)],
        arrived.events
      )
      return { kind: "moved" }
    }
    case "docked": {
      const station = await loadStation(ports, state.at)
      if (station.value.state.status === "revising") {
        return awaitStation(ports, trainId, state.at)
      }
      const started = applied(
        startReview({ train: loaded.value, station: station.value })
      )
      await ports.store.commit(
        loaded.networkId,
        [
          trainWrite(loaded, started.value.train),
          stationWrite(station, started.value.station),
        ],
        started.events
      )
      return { kind: "moved" }
    }
    case "reviewing":
      return review(ports, loaded, await loadStation(ports, state.at))
    case "held":
      return reconsiderHold(ports, loaded)
    case "blocked":
      return { kind: "await_clear" }
    case "returning":
      return returnToTerminus(ports, loaded)
    case "unloaded":
    case "siding":
      return { kind: "finished", status: state.status }
  }
}

async function returnToTerminus(
  ports: TrainPorts,
  train: Loaded<Train>
): Promise<TrainMove> {
  if (train.value.state.status !== "returning")
    throw new Error("Train is not returning")
  if (train.value.state.phase === "awaiting_clearance") {
    const context = {
      holds: await ports.store.holds(train.networkId),
      conflicts: await ports.store.conflicts(train.networkId),
      trainChecks: [],
    }
    const decision = evaluateTerminusEntry(train.value, context)
    if (decision.kind !== "clear") return stopAtGate(ports, train, decision)
    const clearance = await requestTerminusClearance(ports, train.value.id)
    if (!clearance) return { kind: "await_terminus" }
    const cleared = applied(clearForTerminus({ train: train.value, context }))
    await ports.store.commit(
      train.networkId,
      [trainWrite(train, cleared.value)],
      cleared.events
    )
    return { kind: "moved" }
  }
  const attempt = await ports.store.latestIntegration(train.value.id)
  if (!attempt) throw new Error("Integrating Train has no Dispatcher clearance")
  if (attempt.result) {
    await recordIntegrationOutcome(ports, train.value.id, {
      integrationId: attempt.input.id,
      result: attempt.result,
    })
    return { kind: "moved" }
  }
  await ports.startIntegration(attempt.input.id)
  return { kind: "await_integration", integrationId: attempt.input.id }
}

/** Only this Train Workflow applies an integration result to Train state. */
export async function recordIntegrationOutcome(
  ports: TrainPorts,
  trainId: string,
  outcome: IntegrationOutcome
): Promise<void> {
  const train = await loadTrain(ports, trainId)
  if (
    train.value.state.status !== "returning" ||
    train.value.state.phase !== "integrating"
  )
    return
  const attempt = await ports.store.latestIntegration(trainId)
  if (
    !attempt ||
    attempt.input.id !== outcome.integrationId ||
    !attempt.result ||
    attempt.input.trainCommit !== train.value.headCommit
  )
    return
  // Event payloads are wakeups. Durable, validated evidence is authoritative.
  const result = attempt.result
  if (result.ok) {
    const completed = applied(
      completeIntegration({
        train: train.value,
        mergeCommit: result.mergeCommit,
        evidence: result.evidence,
        expectedChecks: attempt.input.validation.map((check) => check.name),
        conflicts: await ports.store.conflicts(train.networkId),
      })
    )
    await ports.store.commit(
      train.networkId,
      [trainWrite(train, completed.value)],
      completed.events
    )
    return
  }
  if (result.holds) {
    const deferred = applied(deferIntegration(train.value))
    const held = applied(holdTrain(deferred.value, result.holds))
    await ports.store.commit(
      train.networkId,
      [trainWrite(train, held.value)],
      [...deferred.events, ...held.events]
    )
    return
  }
  const blocked = applied(blockTrain(train.value, result.issues))
  const writes: Write[] = [trainWrite(train, blocked.value)]
  const events = [...blocked.events]
  if (result.conflictPaths?.length) {
    const conflict = applied(
      detectConflict({
        id: `conflict-${outcome.integrationId}`,
        trainIds: [trainId],
        paths: result.conflictPaths,
        description: result.issues.map((issue) => issue.detail).join("; "),
      })
    )
    writes.push({ kind: "conflict", conflict: conflict.value })
    events.push(...conflict.events)
  }
  await ports.store.commit(train.networkId, writes, events)
}

/**
 * Applies a finished Station run. Outcomes from runs that are no longer
 * current are ignored, so a late or repeated report changes nothing.
 */
export async function recordStationOutcome(
  ports: TrainPorts,
  trainId: TrainId,
  outcome: StationOutcome
): Promise<void> {
  const train = await loadTrain(ports, trainId)
  const station = await loadStation(ports, outcome.stationId)
  const { status } = station.value.state
  if (status !== "signaled" && status !== "active" && status !== "revising") {
    return
  }
  const signals = await ports.store.signalCount(station.value.id)
  if (stationRunId(station.value, signals) !== outcome.runId) return

  if (!outcome.result.ok) {
    await blockTrainAndStation(ports, train, station, outcome.result.issues)
    return
  }
  const ready = applied(
    markReadyForPickup({
      train: train.value,
      station: station.value,
      proposal: outcome.result.proposal,
    })
  )
  await ports.store.commit(
    train.networkId,
    [
      trainWrite(train, ready.value.train),
      stationWrite(station, ready.value.station),
    ],
    ready.events
  )
}

/**
 * Clears a blocked Train after intervention. Its blocked Station goes back to
 * waiting, to be run again from the Train's state on the next departure.
 */
export async function clearTrain(
  ports: TrainPorts,
  trainId: TrainId
): Promise<void> {
  const train = await loadTrain(ports, trainId)
  if (train.value.state.status !== "blocked") return
  const cleared = applied(clearTrainBlock(train.value))
  const writes: Write[] = [trainWrite(train, cleared.value)]
  const events = [...cleared.events]
  for (const station of await ports.store.lineStations(train.value.lineId)) {
    const { state } = station.value
    if (state.status === "blocked" && state.trainId === trainId) {
      const reset = applied(resetStation(station.value))
      writes.push(stationWrite(station, reset.value))
      events.push(...reset.events)
    }
  }
  await ports.store.commit(train.networkId, writes, events)
}

async function departOrReturn(
  ports: TrainPorts,
  loaded: Loaded<Train>
): Promise<TrainMove> {
  const train = loaded.value
  const { line, stations } = await loadLine(ports, train.lineId)
  const ordered = stations.map((station) => station.value)
  const next = nextStation(ordered)

  if (!next) {
    const returned = applied(beginReturn({ train, line, stations: ordered }))
    await ports.store.commit(
      loaded.networkId,
      [trainWrite(loaded, returned.value)],
      returned.events
    )
    return { kind: "moved" }
  }

  const context = await departureContext(ports, loaded.networkId, next)
  const departed = depart({ train, line, stations: ordered, context })
  if (departed.ok) {
    const station = stations.find((s) => s.value.id === next.id)!
    await ports.store.commit(
      loaded.networkId,
      [
        trainWrite(loaded, departed.value.train),
        stationWrite(station, departed.value.station),
      ],
      departed.events
    )
    return { kind: "moved" }
  }
  if (departed.error.code !== "gate_closed") {
    throw new TransitionRejectedError(departed.error)
  }
  return stopAtGate(ports, loaded, departed.error.decision)
}

async function reconsiderHold(
  ports: TrainPorts,
  loaded: Loaded<Train>
): Promise<TrainMove> {
  const train = loaded.value
  if (train.state.status !== "held") throw new Error("Train is not held")

  let decision: GateDecision
  if (train.state.resume.status === "returning") {
    decision = evaluateTerminusEntry(train, {
      holds: await ports.store.holds(loaded.networkId),
      conflicts: await ports.store.conflicts(loaded.networkId),
      trainChecks: [],
    })
  } else {
    const { stations } = await loadLine(ports, train.lineId)
    const next = nextStation(stations.map((station) => station.value))
    decision = next
      ? evaluateDeparture(
          train,
          next,
          await departureContext(ports, loaded.networkId, next)
        )
      : { kind: "clear" }
  }

  if (decision.kind === "hold") return { kind: "await_wake" }
  if (decision.kind === "block") return stopAtGate(ports, loaded, decision)
  const released = applied(releaseTrain(train))
  await ports.store.commit(
    loaded.networkId,
    [trainWrite(loaded, released.value)],
    released.events
  )
  return { kind: "moved" }
}

async function stopAtGate(
  ports: TrainPorts,
  loaded: Loaded<Train>,
  decision: Exclude<GateDecision, { kind: "clear" }>
): Promise<TrainMove> {
  const stopped = applied(
    decision.kind === "hold"
      ? holdTrain(loaded.value, decision.reasons)
      : blockTrain(loaded.value, decision.issues)
  )
  await ports.store.commit(
    loaded.networkId,
    [trainWrite(loaded, stopped.value)],
    stopped.events
  )
  return { kind: "moved" }
}

async function review(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>
): Promise<TrainMove> {
  const { state } = station.value
  if (state.status !== "in_review") {
    throw new Error(`Station ${station.value.id} is not in review`)
  }

  // Failed required checks return the work without asking the Conductor:
  // no review can accept it.
  const failing = unmetRequiredChecks(
    state.proposal.evidence,
    station.value.manifest.expectedEvidence
  )
  if (failing.length > 0) {
    return returnWork(ports, train, station, {
      summary: "Required checks did not pass",
      findings: failing.map((check) => `${check.name}: ${check.status}`),
    })
  }

  const input: ReviewInput = {
    stationId: station.value.id,
    manifest: station.value.manifest,
    proposal: state.proposal,
    trainHead: train.value.headCommit,
    revisionCount: station.value.revisionCount,
  }
  const cached = await ports.store.conductorReview(input, ports.conductor.model)
  let verdict: ConductorVerdict
  try {
    verdict =
      cached ??
      conductorVerdictSchema.parse(await ports.conductor.review(input))
  } catch {
    await blockTrainAndStation(ports, train, station, [
      {
        kind: "review_escalated",
        detail:
          "Conductor review failed or returned invalid structured output; review is required before acceptance",
      },
    ])
    return { kind: "moved" }
  }

  if (!cached)
    await ports.store.recordConductorReview(
      train.networkId,
      input,
      ports.conductor.model,
      verdict
    )

  switch (verdict.verdict) {
    case "return":
      return returnWork(ports, train, station, verdict)
    case "escalate":
      await blockTrainAndStation(ports, train, station, [
        { kind: "review_escalated", detail: verdict.summary },
      ])
      return { kind: "moved" }
    case "accept":
      return accept(ports, train, station, verdict)
  }
}

async function accept(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>,
  verdict: { summary: string; findings: string[] }
): Promise<TrainMove> {
  const result = attachCar({
    train: train.value,
    station: station.value,
    carId: ports.newId("car"),
    review: { ...verdict, model: ports.conductor.model },
    acceptedAt: ports.now(),
  })
  if (!result.ok && result.error.code === "not_fast_forward") {
    await blockTrainAndStation(ports, train, station, [
      { kind: "integration_failed", detail: result.error.message },
    ])
    return { kind: "moved" }
  }
  const attached = applied(result)
  const { car } = attached.value

  // The repository moves first. If the commit below fails, the retried step
  // fast-forwards to the same commit again, which is a no-op.
  if (station.value.state.status === "in_review") {
    try {
      await ports.repositories.fastForward({
        targetRepoId: train.value.repoId,
        sourceRepoId: station.value.state.workspace.repoId,
        fromCommit: car.sourceCommit,
        toCommit: car.acceptedCommit,
      })
    } catch (error) {
      if (!(error instanceof RepositoryMovedError)) throw error
      await blockTrainAndStation(ports, train, station, [
        { kind: "integration_failed", detail: error.message },
      ])
      return { kind: "moved" }
    }
  }
  await ports.store.commit(
    train.networkId,
    [
      trainWrite(train, attached.value.train),
      stationWrite(station, attached.value.station),
      { kind: "car", car },
    ],
    attached.events
  )
  await wakeHeldTrains(ports, train.networkId)
  return { kind: "moved" }
}

async function returnWork(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>,
  feedback: ReviewFeedback
): Promise<TrainMove> {
  const returned = applied(
    returnToStation({ train: train.value, station: station.value, feedback })
  )
  await ports.store.commit(
    train.networkId,
    [
      trainWrite(train, returned.value.train),
      stationWrite(station, returned.value.station),
    ],
    returned.events
  )
  return { kind: "moved" }
}

async function blockTrainAndStation(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>,
  issues: Issue[]
): Promise<void> {
  const blockedStation = applied(blockStation(station.value, issues))
  const blockedTrain = applied(blockTrain(train.value, issues))
  await ports.store.commit(
    train.networkId,
    [
      trainWrite(train, blockedTrain.value),
      stationWrite(station, blockedStation.value),
    ],
    [...blockedStation.events, ...blockedTrain.events]
  )
}

async function awaitStation(
  ports: TrainPorts,
  trainId: TrainId,
  stationId: StationId
): Promise<TrainMove> {
  const station = await loadStation(ports, stationId)
  const { status } = station.value.state
  if (status !== "signaled" && status !== "active" && status !== "revising") {
    throw new Error(
      `Train ${trainId} is waiting on ${stationId}, which is ${status}`
    )
  }
  const runId = stationRunId(
    station.value,
    await ports.store.signalCount(stationId)
  )
  await ports.startStationRun({ trainId, stationId, runId })
  return { kind: "await_station", runId }
}

async function departureContext(
  ports: TrainPorts,
  networkId: NetworkId,
  station: Station
): Promise<DepartureContext> {
  const [holds, conflicts, dependencies] = await Promise.all([
    ports.store.holds(networkId),
    ports.store.conflicts(networkId),
    ports.store.stationStatuses(station.manifest.dependencies),
  ])
  // No Train-level validation runs yet, so there are no Train checks.
  return { holds, conflicts, dependencies, trainChecks: [] }
}

async function wakeHeldTrains(
  ports: TrainPorts,
  networkId: NetworkId
): Promise<void> {
  const trains = await ports.store.trains(networkId)
  await Promise.allSettled(
    trains
      .filter((train) => train.value.state.status === "held")
      .map((train) => ports.wakeTrain(train.value.id))
  )
}

async function loadTrain(
  ports: TrainPorts,
  trainId: TrainId
): Promise<Loaded<Train>> {
  const train = await ports.store.train(trainId)
  if (!train) throw new Error(`Train ${trainId} does not exist`)
  return train
}

async function loadStation(
  ports: TrainPorts,
  stationId: StationId
): Promise<Loaded<Station>> {
  const station = await ports.store.station(stationId)
  if (!station) throw new Error(`Station ${stationId} does not exist`)
  return station
}

async function loadLine(
  ports: TrainPorts,
  lineId: string
): Promise<{ line: Line; stations: Loaded<Station>[] }> {
  const line = await ports.store.line(lineId)
  if (!line) throw new Error(`Line ${lineId} does not exist`)
  const byId = new Map(
    (await ports.store.lineStations(lineId)).map((s) => [s.value.id, s])
  )
  const stations = line.stationIds.map((id) => {
    const station = byId.get(id)
    if (!station) throw new Error(`Station ${id} on Line ${lineId} is missing`)
    return station
  })
  return { line, stations }
}

function trainWrite(loaded: Loaded<Train>, train: Train): Write {
  return { kind: "train", train, version: loaded.version }
}

function stationWrite(loaded: Loaded<Station>, station: Station): Write {
  return { kind: "station", station, version: loaded.version }
}
