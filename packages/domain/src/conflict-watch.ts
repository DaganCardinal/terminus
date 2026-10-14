import type { Car } from "./car"
import { pathsOverlap } from "./dispatch-plan"
import type { DomainEvent } from "./events"
import type { CarId, LineId, StationId, TrainId } from "./ids"
import type { Station } from "./station"
import { isTerminal, type Train } from "./train"

/**
 * The Dispatcher's watch over one accepted Car: does it look like it will
 * collide with work on another Line? A watch is advisory. Unlike a
 * `Conflict`, which records a real merge failure and closes gates, nothing
 * here changes movement; the user decides what to do with a report.
 */
export interface ConflictWatch {
  /** `watch-<carId>`: one watch per Car. */
  id: string
  trainId: TrainId
  lineId: LineId
  carId: CarId
  stationId: StationId
  createdAt: string
  /** Cars accepted before watching existed are recorded but never examined. */
  baseline?: boolean
  pairs: ConflictPair[]
}

/** Evidence found without a model. */
export interface ConflictOverlap {
  /** Files this Car changed that Cars on the other Train also changed. */
  sharedPaths: string[]
  /** Unfinished Stations on the other Line whose expected areas this Car changed. */
  plannedAreas: { stationId: StationId; paths: string[] }[]
  /** Contracts both sides declare, as `kind: name`. */
  sharedContracts: string[]
  /** Directories both Trains changed files in, without sharing a file. */
  sharedDirectories: string[]
}

/**
 * - `triage`: no direct overlap; waiting for the Dispatcher's Clef.
 * - `investigate`: waiting for the Dispatcher's investigation.
 * - `confirmed`: the investigation found a likely conflict and reported it.
 * - `dismissed`: Clef or the investigation found nothing to report.
 * - `failed`: the investigation could not finish.
 * - `skipped`: the other Train left the network before it was examined.
 */
export type ConflictPairStage =
  "triage" | "investigate" | "confirmed" | "dismissed" | "failed" | "skipped"

export interface ConflictTriage {
  likely: boolean
  /** Clef's probability of a conflict; null when it gave no answer. */
  probability: number | null
  model: string
  error?: string
}

export interface ConflictFinding {
  /** `textual` when a trial merge conflicted, else `semantic`. */
  kind: "textual" | "semantic"
  summary: string
  paths: string[]
  details: string[]
  /** The Train the Dispatcher suggests holding until the other reaches Terminus. */
  suggestedHold?: TrainId
}

export interface ConflictInvestigation {
  model: string
  /** The exact commits examined. */
  commits: { train: string; other: string }
  /** Null when no trial merge ran (offline simulation). */
  trialMerge: { clean: boolean; conflictPaths: string[] } | null
  checks?: { name: string; status: string }[]
  summary: string
  finding?: ConflictFinding
}

export interface ConflictPair {
  otherTrainId: TrainId
  otherLineId: LineId
  /** `overlap` skips Clef: shared files or planned areas always get investigated. */
  route: "overlap" | "triage"
  overlap: ConflictOverlap
  stage: ConflictPairStage
  triage?: ConflictTriage
  investigation?: ConflictInvestigation
  /** Why a pair was dismissed, skipped or failed. */
  reason?: string
  reportedAt?: string
  acknowledgedAt?: string
}

/** Clef must find a conflict more likely than not before a Sandbox is spent on it. */
export const CONFLICT_TRIAGE_THRESHOLD = 0.5

/** Each Car asks Clef about at most this many unrelated Trains, closest first. */
export const MAX_TRIAGE_PAIRS = 6

export function conflictWatchId(carId: CarId): string {
  return `watch-${carId}`
}

/** Only work a Conductor accepted is new; copied Cars repeat it. */
export function watchableCar(car: Car): boolean {
  return !car.originCarId && !car.sourceCarId && !car.copiedAt
}

export function conflictTriageLikely(
  probability: number | null,
  threshold = CONFLICT_TRIAGE_THRESHOLD
): boolean {
  return probability !== null && probability > threshold
}

function directory(path: string): string | null {
  const index = path.lastIndexOf("/")
  return index > 0 ? path.slice(0, index) : null
}

const unfinished = (station: Station) =>
  !["complete", "cancelled"].includes(station.state.status)

const contractKeys = (
  manifests: { contracts: Car["manifest"]["contracts"] }[]
) =>
  new Set(
    manifests.flatMap((manifest) =>
      manifest.contracts.map((contract) => `${contract.kind}: ${contract.name}`)
    )
  )

/**
 * Compares one Car with every other running Train. Files both sides changed,
 * or areas the other Line still plans to change, go straight to
 * investigation. Other Trains with work of their own go to Clef, closest
 * first. Trains with nothing to compare are left out, as are Trains reported
 * with this one and not yet acknowledged. A running investigation covers
 * earlier snapshots, so it must not suppress a check of a newer Car.
 */
export function screenCar(input: {
  car: Car
  train: Train
  trains: Train[]
  cars: Car[]
  stations: Station[]
  concerns?: ConflictConcern[]
  maxTriage?: number
}): ConflictPair[] {
  const { car, train } = input
  const changed = [...new Set(car.changedPaths)]
  const ownDirectories = new Set(
    changed.map(directory).filter((dir): dir is string => dir !== null)
  )
  const ownCars = new Set(
    input.cars.filter((c) => c.trainId === train.id).map((c) => c.id)
  )
  const ownContracts = contractKeys([car.manifest])
  const overlaps: ConflictPair[] = []
  const triage: ConflictPair[] = []
  const concerned = new Set(
    (input.concerns ?? [])
      .filter(
        (concern) =>
          concern.pair.stage === "confirmed" && !concern.pair.acknowledgedAt
      )
      .flatMap((concern) =>
        concern.trainId === train.id
          ? [concern.pair.otherTrainId]
          : concern.pair.otherTrainId === train.id
            ? [concern.trainId]
            : []
      )
  )
  for (const other of input.trains) {
    if (other.id === train.id || other.lineId === train.lineId) continue
    if (isTerminal(other) || concerned.has(other.id)) continue
    // Copies of this Train's own work are not the other Line's changes.
    const cars = input.cars.filter(
      (c) =>
        c.trainId === other.id &&
        !ownCars.has(c.sourceCarId ?? "") &&
        !ownCars.has(c.originCarId ?? "")
    )
    const stations = input.stations.filter(
      (station) => station.lineId === other.lineId && unfinished(station)
    )
    if (!cars.length && !stations.length) continue
    const theirPaths = new Set(cars.flatMap((c) => c.changedPaths))
    const sharedPaths = changed.filter((path) => theirPaths.has(path)).sort()
    const plannedAreas = stations
      .map((station) => ({
        stationId: station.id,
        paths: changed.filter((path) =>
          station.manifest.expectedAreas.some((area) =>
            pathsOverlap(path, area)
          )
        ),
      }))
      .filter((planned) => planned.paths.length > 0)
    const theirContracts = contractKeys([
      ...cars.map((c) => c.manifest),
      ...stations.map((station) => station.manifest),
    ])
    const sharedContracts = [...ownContracts]
      .filter((key) => theirContracts.has(key))
      .sort()
    const shared = new Set(sharedPaths)
    const sharedDirectories = [
      ...new Set(
        [...theirPaths]
          .filter((path) => !shared.has(path))
          .map(directory)
          .filter(
            (dir): dir is string => dir !== null && ownDirectories.has(dir)
          )
      ),
    ].sort()
    const pair: ConflictPair = {
      otherTrainId: other.id,
      otherLineId: other.lineId,
      route: sharedPaths.length || plannedAreas.length ? "overlap" : "triage",
      overlap: {
        sharedPaths,
        plannedAreas,
        sharedContracts,
        sharedDirectories,
      },
      stage:
        sharedPaths.length || plannedAreas.length ? "investigate" : "triage",
    }
    ;(pair.route === "overlap" ? overlaps : triage).push(pair)
  }
  const closeness = (pair: ConflictPair) =>
    pair.overlap.sharedContracts.length * 10 +
    pair.overlap.sharedDirectories.length
  triage.sort((a, b) => closeness(b) - closeness(a))
  return [...overlaps, ...triage.slice(0, input.maxTriage ?? MAX_TRIAGE_PAIRS)]
}

export function startConflictWatch(input: {
  car: Car
  train: Train
  pairs: ConflictPair[]
  at: string
}): { watch: ConflictWatch; events: DomainEvent[] } {
  const watch: ConflictWatch = {
    id: conflictWatchId(input.car.id),
    trainId: input.train.id,
    lineId: input.train.lineId,
    carId: input.car.id,
    stationId: input.car.stationId,
    createdAt: input.at,
    pairs: input.pairs,
  }
  return {
    watch,
    events: input.pairs
      .filter((pair) => pair.stage === "investigate")
      .map((pair) => investigatingEvent(watch, pair)),
  }
}

function investigatingEvent(
  watch: ConflictWatch,
  pair: ConflictPair
): DomainEvent {
  return {
    type: "dispatcher.conflict_investigating",
    trainId: watch.trainId,
    watchId: watch.id,
    otherTrainId: pair.otherTrainId,
    route: pair.route,
  }
}

function update(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  change: (pair: ConflictPair) => ConflictPair
): ConflictWatch {
  return {
    ...watch,
    pairs: watch.pairs.map((pair) =>
      pair.otherTrainId === otherTrainId ? change(pair) : pair
    ),
  }
}

export function conflictPair(
  watch: ConflictWatch,
  otherTrainId: TrainId
): ConflictPair | undefined {
  return watch.pairs.find((pair) => pair.otherTrainId === otherTrainId)
}

/** Records Clef's answer. Nothing changes unless the pair is waiting for it. */
export function triageConflictPair(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  triage: ConflictTriage
): { watch: ConflictWatch; events: DomainEvent[] } {
  const pair = conflictPair(watch, otherTrainId)
  if (pair?.stage !== "triage") return { watch, events: [] }
  const next: ConflictPair = triage.likely
    ? { ...pair, triage, stage: "investigate" }
    : {
        ...pair,
        triage,
        stage: "dismissed",
        reason:
          triage.probability === null
            ? "Clef gave no answer, and the Lines share no files"
            : "Clef judged a conflict unlikely",
      }
  return {
    watch: update(watch, otherTrainId, () => next),
    events: triage.likely ? [investigatingEvent(watch, next)] : [],
  }
}

/**
 * Records the investigation. A trial merge that conflicted is a fact, so it
 * is reported whatever the model concluded.
 */
export function concludeConflictInvestigation(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  investigation: ConflictInvestigation,
  at: string
): { watch: ConflictWatch; events: DomainEvent[] } {
  const pair = conflictPair(watch, otherTrainId)
  if (pair?.stage !== "investigate") return { watch, events: [] }
  const conflicted = investigation.trialMerge?.conflictPaths ?? []
  const finding: ConflictFinding | undefined = conflicted.length
    ? {
        kind: "textual",
        summary:
          investigation.finding?.summary ??
          `A trial merge of both Trains conflicts in ${conflicted.join(", ")}.`,
        paths: [
          ...new Set([...conflicted, ...(investigation.finding?.paths ?? [])]),
        ],
        details: investigation.finding?.details ?? [],
        suggestedHold: investigation.finding?.suggestedHold,
      }
    : investigation.finding
  const recorded = { ...investigation, finding }
  if (!finding) {
    return {
      watch: update(watch, otherTrainId, (p) => ({
        ...p,
        investigation: recorded,
        stage: "dismissed",
        reason: investigation.summary,
      })),
      events: [
        {
          type: "dispatcher.conflict_cleared",
          trainId: watch.trainId,
          watchId: watch.id,
          otherTrainId,
          summary: investigation.summary,
        },
      ],
    }
  }
  return {
    watch: update(watch, otherTrainId, (p) => ({
      ...p,
      investigation: recorded,
      stage: "confirmed",
      reportedAt: at,
    })),
    events: [
      {
        type: "dispatcher.conflict_reported",
        trainId: watch.trainId,
        watchId: watch.id,
        otherTrainId,
        summary: finding.summary,
        paths: finding.paths,
      },
    ],
  }
}

export function failConflictInvestigation(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  reason: string
): { watch: ConflictWatch; events: DomainEvent[] } {
  const pair = conflictPair(watch, otherTrainId)
  if (pair?.stage !== "investigate") return { watch, events: [] }
  return {
    watch: update(watch, otherTrainId, (p) => ({
      ...p,
      stage: "failed",
      reason,
    })),
    events: [
      {
        type: "dispatcher.conflict_investigation_failed",
        trainId: watch.trainId,
        watchId: watch.id,
        otherTrainId,
        reason,
      },
    ],
  }
}

/** The other Train finished or was abandoned first; Terminus integration takes over. */
export function skipConflictPair(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  reason: string
): ConflictWatch {
  const pair = conflictPair(watch, otherTrainId)
  if (pair?.stage !== "triage" && pair?.stage !== "investigate") return watch
  return update(watch, otherTrainId, (p) => ({
    ...p,
    stage: "skipped",
    reason,
  }))
}

export function acknowledgeConflictPair(
  watch: ConflictWatch,
  otherTrainId: TrainId,
  at: string
): { watch: ConflictWatch; events: DomainEvent[] } {
  const pair = conflictPair(watch, otherTrainId)
  if (pair?.stage !== "confirmed" || pair.acknowledgedAt)
    return { watch, events: [] }
  return {
    watch: update(watch, otherTrainId, (p) => ({ ...p, acknowledgedAt: at })),
    events: [
      {
        type: "dispatcher.conflict_acknowledged",
        trainId: watch.trainId,
        watchId: watch.id,
        otherTrainId,
      },
    ],
  }
}

/** A pair the Dispatcher is checking or has reported, as the user sees it. */
export interface ConflictConcern {
  watchId: string
  trainId: TrainId
  lineId: LineId
  carId: CarId
  stationId: StationId
  pair: ConflictPair
}

/**
 * Reports the user has not acknowledged, and checks still running, while
 * both Trains are still running. Once either Train finishes or is
 * abandoned, Terminus integration checks the real merge instead.
 */
export function activeConflictConcerns(
  watches: ConflictWatch[],
  trains: Train[]
): ConflictConcern[] {
  const running = new Set(
    trains.filter((train) => !isTerminal(train)).map((train) => train.id)
  )
  return watches.flatMap((watch) =>
    running.has(watch.trainId)
      ? watch.pairs
          .filter(
            (pair) =>
              running.has(pair.otherTrainId) &&
              ((pair.stage === "confirmed" && !pair.acknowledgedAt) ||
                pair.stage === "investigate")
          )
          .map((pair) => ({
            watchId: watch.id,
            trainId: watch.trainId,
            lineId: watch.lineId,
            carId: watch.carId,
            stationId: watch.stationId,
            pair,
          }))
      : []
  )
}
