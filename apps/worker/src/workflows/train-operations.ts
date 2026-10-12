import { advanceJunctionTrain } from "./junction-train-operations"
import { advanceCrossing, recordCrossingOutcome } from "./crossing-operations"
import {
  stationBrief,
  type Conductor,
  type EngineerAdvisor,
  type ReviewInput,
} from "@terminus/agent-runtime"
import { RepositoryMovedError, type RepositoryHost } from "@terminus/artifacts"
import {
  sendToSiding,
  stationCheckpoint,
  arrive,
  attachCar,
  beginReturn,
  clearForTerminus,
  completeIntegration,
  deferIntegration,
  conflictsForRepair,
  repairMatches,
  detectConflict,
  blockStation,
  blockTrain,
  clearTrainBlock,
  depart,
  evaluateDeparture,
  evaluateStationRetry,
  evaluateTerminusEntry,
  unmetRequiredChecks,
  holdTrain,
  recordStationEvidence,
  markReadyForPickup,
  nextStation,
  releaseTrain,
  resetStation,
  removeStation,
  retryStationRun,
  returnToStation,
  startReview,
  type DepartureContext,
  type DomainEvent,
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
  perfSpan,
  stationVerdictSchema,
  type StationOutcome,
  type IntegrationOutcome,
} from "@terminus/protocol"
import {
  requestTerminusClearance,
  stationRetryUserAlert,
} from "../agents/dispatcher"
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
  /** Advises on choices the Engineer's hard gates leave open. */
  engineer: EngineerAdvisor
  stationMaxRetries: number
  /** Starts a Station run. Starting a run that already exists does nothing. */
  startStationRun(params: StationRunParams): Promise<void>
  startIntegration(integrationId: string): Promise<void>
  /** Asks a held Train to evaluate its gate again. */
  wakeJunction?(id: string): Promise<void>
  wakeTrain(trainId: TrainId): Promise<void>
  newId(prefix: string): string
  now(): string
}

/** What the Train Workflow does after a step. */
export type TrainMove =
  | { kind: "moved" }
  | { kind: "await_station"; runId: string }
  | { kind: "review"; stationId: StationId }
  | { kind: "await_wake" }
  | { kind: "await_clear" }
  | { kind: "await_terminus" }
  | { kind: "await_integration"; integrationId: string }
  | { kind: "finished"; status: "unloaded" | "siding" }

/**
 * Identifies one run of a Station: each signal starts a fresh workspace, and
 * each revision is another run on the same workspace. A failed run the
 * Engineer retries is another run too.
 */
export function stationRunId(station: Station, signalCount: number): string {
  const retries = station.runRetries ? `-f${station.runRetries}` : ""
  return `${station.id}-s${signalCount}-r${station.revisionCount}${retries}`
}

/** How long the Train waits before rerunning a Station the Engineer paused. */
export const STATION_RETRY_BACKOFF = "5 minutes"

/** Whether the Train Workflow waits before its next move. */
export interface RecordedStationOutcome {
  backoff: boolean
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
  const siding = await ports.store.sidingRequest(trainId)
  if (siding !== null) {
    const active = (await ports.store.integrations(loaded.networkId)).some(
      (a) =>
        a.input.trainId === trainId &&
        ["cleared", "prepared"].includes(a.status)
    )
    if (active)
      throw new Error("Cannot abandon a Train with an unresolved promotion")
    const result = applied(sendToSiding(loaded.value, siding))
    await ports.store.commit(
      loaded.networkId,
      [trainWrite(loaded, result.value), { kind: "siding_consumed", trainId }],
      result.events
    )
    await wakeHeldTrains(ports, loaded.networkId)
    return { kind: "finished", status: "siding" }
  }
  if (await applyStationRemoval(ports, loaded)) return { kind: "moved" }
  if (await applyStationStop(ports, loaded)) return { kind: "moved" }
  const junctionMove = await advanceJunctionTrain(ports, loaded)
  if (junctionMove) return junctionMove
  const crossingMove = await advanceCrossing(ports, loaded)
  if (crossingMove) return crossingMove
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
    case "blocked": {
      const repair = await ports.store.approvedRepair(trainId)
      const network = repair && (await ports.store.network(loaded.networkId))
      const previous = repair && (await ports.store.latestIntegration(trainId))
      const conflicts =
        repair && network
          ? conflictsForRepair(
              await ports.store.conflicts(loaded.networkId),
              repair,
              {
                trainCommit: loaded.value.headCommit,
                terminusCommit: network.terminusCommit,
              }
            )
          : []
      if (
        repair &&
        network &&
        previous?.status === "failed" &&
        state.resume.status === "returning" &&
        repairMatches(repair, {
          trainCommit: loaded.value.headCommit,
          terminusCommit: network.terminusCommit,
        }) &&
        evaluateTerminusEntry(loaded.value, {
          holds: [],
          conflicts,
          trainChecks: [],
        }).kind !== "block"
      ) {
        await clearTrain(ports, trainId)
        return { kind: "moved" }
      }
      return { kind: "await_clear" }
    }
    case "returning":
      return returnToTerminus(ports, loaded)
    case "unloaded":
    case "siding":
      return { kind: "finished", status: state.status }
  }
}

/** Commands are durable Station metadata, revalidated against current network state. */
async function applyStationRemoval(
  ports: TrainPorts,
  train: Loaded<Train>
): Promise<boolean> {
  const stations = await ports.store.stations(train.networkId)
  const requested = stations.find(
    (s) => s.value.lineId === train.value.lineId && s.value.removalRequest
  )
  if (!requested) return false
  const line = await ports.store.line(train.value.lineId)
  if (!line) throw new Error("Train has no Line")
  const { removalRequest, ...station } = requested.value
  const sidedLines = new Set(
    (await ports.store.trains(train.networkId))
      .filter((t) => t.value.state.status === "siding")
      .map((t) => t.value.lineId)
  )
  const result = removeStation({
    train: train.value,
    line,
    station,
    stations: stations.map((s) => s.value),
    crossings: (await ports.store.crossings(train.networkId)).filter(
      (c) => !sidedLines.has(c.lineId)
    ),
    reason: removalRequest!.reason,
  })
  if (!result.ok) {
    await ports.store.commit(
      train.networkId,
      [stationWrite(requested, station)],
      [
        {
          type: "station.removal_refused",
          stationId: station.id,
          reason: result.error.message,
        },
      ]
    )
    return true
  }
  await ports.store.commit(
    train.networkId,
    [
      stationWrite(requested, result.value.station),
      trainWrite(train, result.value.train),
    ],
    result.events
  )
  return true
}

async function returnToTerminus(
  ports: TrainPorts,
  train: Loaded<Train>
): Promise<TrainMove> {
  if (train.value.state.status !== "returning")
    throw new Error("Train is not returning")
  if (train.value.state.phase === "awaiting_clearance") {
    const repair = await ports.store.approvedRepair(train.value.id)
    const network = await ports.store.network(train.networkId)
    const context = {
      unloadPolicy: (await ports.store.unloadPolicy(train.value.id))?.value,
      holds: await ports.store.holds(train.networkId),
      conflicts: conflictsForRepair(
        await ports.store.conflicts(train.networkId),
        repair,
        {
          trainCommit: train.value.headCommit,
          terminusCommit: network!.terminusCommit,
        }
      ),
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
  const saved = await ports.store.integration(outcome.integrationId)
  if (saved?.input.purpose === "junction") {
    const loaded = await loadTrain(ports, trainId)
    await advanceJunctionTrain(ports, loaded)
    return
  }
  if (saved?.input.purpose === "crossing")
    return recordCrossingOutcome(ports, trainId, outcome)
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
): Promise<RecordedStationOutcome> {
  const train = await loadTrain(ports, trainId)
  const station = await loadStation(ports, outcome.stationId)
  if (station.value.stopRequest && (await applyStationStop(ports, train)))
    return { backoff: false }
  const { status } = station.value.state
  if (status !== "signaled" && status !== "active" && status !== "revising") {
    return { backoff: false }
  }
  const signals = await ports.store.signalCount(station.value.id)
  if (stationRunId(station.value, signals) !== outcome.runId)
    return { backoff: false }

  if (!outcome.result.ok)
    return retryOrBlock(ports, train, station, outcome.result.issues)
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
  return { backoff: false }
}

/**
 * A failed run blocks the Train unless its retry allowance remains and the
 * Engineer's decision model is confident the failure won't recur.
 */
async function retryOrBlock(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>,
  issues: Issue[]
): Promise<RecordedStationOutcome> {
  const advice =
    evaluateStationRetry(station.value, ports.stationMaxRetries).kind ===
    "clear"
      ? await perfSpan(
          "engineer.station_failure",
          { stationId: station.value.id },
          () =>
            ports.engineer.stationFailure({
              station: stationBrief(station.value, ports.stationMaxRetries),
              issues,
            }),
          (advice) => ({ advice })
        )
      : null
  if (!advice || advice.value === "escalate") {
    await blockTrainAndStation(ports, train, station, issues)
    return { backoff: false }
  }
  const backoff = advice.value === "wait"
  const retried = applied(
    retryStationRun({
      train: train.value,
      station: station.value,
      issues,
      backoff,
      maxRetries: ports.stationMaxRetries,
    })
  )
  await ports.store.commit(
    train.networkId,
    [stationWrite(station, retried.value)],
    retried.events
  )
  return { backoff }
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
  if (
    (await ports.store.crossings(train.networkId)).some(
      (c) => c.lineId === train.value.lineId && c.state.status === "blocked"
    )
  )
    return
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
  const crossings = await ports.store.crossings(loaded.networkId)
  const next = nextStation(ordered)

  if (!next) {
    const returned = applied(
      beginReturn({ train, line, stations: ordered, crossings })
    )
    await ports.store.commit(
      loaded.networkId,
      [trainWrite(loaded, returned.value)],
      returned.events
    )
    return { kind: "moved" }
  }

  const context = await departureContext(ports, loaded.networkId, next)
  const departed = depart({
    train,
    line,
    stations: ordered,
    context,
    crossings,
  })
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
    const repair = await ports.store.approvedRepair(train.id)
    const network = await ports.store.network(loaded.networkId)
    decision = evaluateTerminusEntry(train, {
      unloadPolicy: (await ports.store.unloadPolicy(train.id))?.value,
      holds: await ports.store.holds(loaded.networkId),
      conflicts: conflictsForRepair(
        await ports.store.conflicts(loaded.networkId),
        repair,
        {
          trainCommit: train.headCommit,
          terminusCommit: network!.terminusCommit,
        }
      ),
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

  if (decision.kind === "hold") {
    const refreshed = applied(holdTrain(train, decision.reasons))
    if (refreshed.events.length)
      await ports.store.commit(
        loaded.networkId,
        [trainWrite(loaded, refreshed.value)],
        refreshed.events
      )
    return { kind: "await_wake" }
  }
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
  const alerts: DomainEvent[] = []
  if (
    decision.kind === "block" &&
    decision.issues.some((issue) => issue.kind === "station_change_required")
  ) {
    const { stations } = await loadLine(ports, loaded.value.lineId)
    const next = nextStation(stations.map((s) => s.value))
    if (next)
      alerts.push({
        type: "dispatcher.user_attention_requested",
        trainId: loaded.value.id,
        stationId: next.id,
        issues: decision.issues,
      })
  }
  await ports.store.commit(
    loaded.networkId,
    [trainWrite(loaded, stopped.value)],
    [...stopped.events, ...alerts]
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
  // no review can accept it. Work without evidence gets it during review.
  if (state.proposal.evidence.checks.length) {
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
  }

  // The verdict is recorded by its own long-running step (`reviewStation`);
  // this step only applies it.
  const recorded = await ports.store.conductorReview(
    reviewInput(train, station),
    ports.conductor.config ?? ports.conductor.model
  )
  if (!recorded) return { kind: "review", stationId: station.value.id }
  const { evidence, ...verdict } = recorded
  // Evidence the review collected is applied with its verdict, never before:
  // the review's identity includes the proposal it was given.
  const reviewed = evidence
    ? {
        ...station,
        value: applied(recordStationEvidence(station.value, evidence)).value,
      }
    : station

  switch (verdict.verdict) {
    case "return":
      return returnWork(ports, train, reviewed, verdict)
    case "escalate":
      await blockTrainAndStation(ports, train, reviewed, [
        { kind: "review_escalated", detail: verdict.summary },
      ])
      return { kind: "moved" }
    case "accept":
      return accept(ports, train, reviewed, verdict)
  }
}

function reviewInput(
  train: Loaded<Train>,
  station: Loaded<Station>
): ReviewInput {
  const { state } = station.value
  if (state.status !== "in_review")
    throw new Error(`Station ${station.value.id} is not in review`)
  return {
    stationId: station.value.id,
    manifest: station.value.manifest,
    proposal: state.proposal,
    trainHead: train.value.headCommit,
    revisionCount: station.value.revisionCount,
  }
}

/** The Train and Station whose review is still awaiting a verdict, if any. */
async function pendingReview(
  ports: TrainPorts,
  trainId: TrainId
): Promise<{
  train: Loaded<Train>
  station: Loaded<Station>
  input: ReviewInput
} | null> {
  const train = await loadTrain(ports, trainId)
  if (train.value.state.status !== "reviewing") return null
  const station = await loadStation(ports, train.value.state.at)
  if (station.value.state.status !== "in_review") return null
  const input = reviewInput(train, station)
  if (
    await ports.store.conductorReview(
      input,
      ports.conductor.config ?? ports.conductor.model
    )
  )
    return null
  return { train, station, input }
}

/**
 * Asks the Conductor for a verdict and records it durably, without changing
 * Train state. A harness Conductor verifies the candidate in a Sandbox, which
 * takes minutes, so this runs as its own Workflow step. Safe to repeat.
 */
export async function reviewStation(
  ports: TrainPorts,
  trainId: TrainId
): Promise<void> {
  const pending = await pendingReview(ports, trainId)
  if (!pending) return
  const { train, station, input } = pending
  const network = await ports.store.network(train.networkId)
  if (!network) throw new Error(`Unknown network ${train.networkId}`)
  if (station.value.state.status !== "in_review")
    throw new Error(`Station ${station.value.id} is not in review`)
  const repoId = station.value.state.workspace.repoId
  const verdict = stationVerdictSchema.parse(
    await perfSpan(
      "conductor.review",
      { stationId: station.value.id, revision: station.value.revisionCount },
      () =>
        ports.conductor.review(input, {
          repoId,
          validation: network.validation,
        }),
      (result) => ({ verdict: result.verdict })
    )
  )
  await ports.store.recordConductorReview(
    train.networkId,
    input,
    ports.conductor.config ?? ports.conductor.model,
    verdict
  )
}

/** Review is required before acceptance, so a review that cannot finish blocks the Train. */
export async function failReview(
  ports: TrainPorts,
  trainId: TrainId
): Promise<void> {
  const pending = await pendingReview(ports, trainId)
  if (!pending) return
  await blockTrainAndStation(ports, pending.train, pending.station, [
    {
      kind: "review_escalated",
      detail:
        "Conductor review failed or returned invalid structured output; review is required before acceptance",
    },
  ])
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
    review: {
      ...verdict,
      ...ports.conductor.config,
      model: ports.conductor.model,
    },
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
      {
        kind: "checkpoint",
        checkpoint: stationCheckpoint(
          attached.value.train,
          attached.value.station
        )!,
      },
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
  // Within the allowance, the Engineer may stop a revision loop early.
  if (
    evaluateStationRetry(station.value, ports.stationMaxRetries).kind ===
    "clear"
  ) {
    const advice = await perfSpan(
      "engineer.revision",
      { stationId: station.value.id },
      () =>
        ports.engineer.revision({
          station: stationBrief(station.value, ports.stationMaxRetries),
          feedback,
          previousFeedback: station.value.lastReview?.feedback ?? null,
        }),
      (result) => ({ advice: result })
    )
    if (advice.value === "escalate") {
      await blockTrainAndStation(
        ports,
        train,
        station,
        [
          {
            kind: "engineer_escalated",
            detail: `The Engineer judged another automatic revision of Station ${station.value.name} unlikely to succeed${advice.confidence === null ? "" : ` (${Math.round(advice.confidence * 100)}% confident)`}. User intervention is required.`,
          },
        ],
        feedback
      )
      return { kind: "moved" }
    }
  }
  const result = returnToStation({
    train: train.value,
    station: station.value,
    feedback,
    maxRetries: ports.stationMaxRetries,
  })
  if (!result.ok) {
    if (
      result.error.code !== "gate_closed" ||
      result.error.decision.kind !== "block"
    )
      throw new TransitionRejectedError(result.error)
    await blockTrainAndStation(
      ports,
      train,
      station,
      result.error.decision.issues,
      feedback
    )
    return { kind: "moved" }
  }
  const returned = result
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

/** Stop requests are hard user decisions, never Engineer model choices. */
async function applyStationStop(
  ports: TrainPorts,
  train: Loaded<Train>
): Promise<boolean> {
  const state = train.value.state
  const stationId =
    state.status === "in_transit" || state.status === "approaching"
      ? state.toward
      : state.status === "docked" || state.status === "reviewing"
        ? state.at
        : null
  if (!stationId) return false
  const station = await loadStation(ports, stationId)
  if (
    !station.value.stopRequest ||
    ["blocked", "complete", "cancelled"].includes(station.value.state.status)
  )
    return false
  await blockTrainAndStation(ports, train, station, [
    {
      kind: "needs_user",
      detail: station.value.stopRequest.reason,
    },
  ])
  return true
}

async function blockTrainAndStation(
  ports: TrainPorts,
  train: Loaded<Train>,
  station: Loaded<Station>,
  issues: Issue[],
  feedback?: ReviewFeedback
): Promise<void> {
  const blockedStation = applied(
    blockStation(
      station.value,
      issues,
      feedback ??
        (station.value.state.status === "in_review"
          ? {
              summary: issues.map((issue) => issue.detail).join("; "),
              findings: [],
            }
          : undefined)
    )
  )
  const blockedTrain = applied(blockTrain(train.value, issues))
  await ports.store.commit(
    train.networkId,
    [
      trainWrite(train, blockedTrain.value),
      stationWrite(station, blockedStation.value),
    ],
    [
      ...blockedStation.events,
      ...blockedTrain.events,
      ...stationRetryUserAlert(blockedTrain.value, blockedStation.value),
    ]
  )
}

async function awaitStation(
  ports: TrainPorts,
  trainId: TrainId,
  stationId: StationId
): Promise<TrainMove> {
  const station = await loadStation(ports, stationId)
  if (station.value.stopRequest) {
    await applyStationStop(ports, await loadTrain(ports, trainId))
    return { kind: "moved" }
  }
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
