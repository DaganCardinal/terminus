import type {
  ConflictCarBrief,
  ConflictInvestigator,
  ConflictSide,
  ConflictSituation,
  ConflictTriageAdvisor,
} from "@terminus/agent-runtime"
import {
  activeConflictConcerns,
  concludeConflictInvestigation,
  conflictPair,
  failConflictInvestigation,
  isTerminal,
  screenCar,
  skipConflictPair,
  startConflictWatch,
  triageConflictPair,
  watchableCar,
  type Car,
  type ConflictPair,
  type ConflictWatch,
  type DomainEvent,
  type Station,
  type Train,
} from "@terminus/domain"
import {
  StaleWriteError,
  type NetworkStore,
} from "../integrations/network-store"

export interface ConflictWatchPorts {
  store: NetworkStore
  /** The Dispatcher's Clef. */
  triage: ConflictTriageAdvisor
  investigator: ConflictInvestigator
  now(): string
}

/**
 * Runs after a Train moves. Each new Car gets a watch: the deterministic
 * screen runs here, in the Train's step, and pairs that need a model are
 * handed to a Conflict Watch Workflow so the Train never waits for one.
 */
export async function watchNewCars(
  ports: {
    store: NetworkStore
    now(): string
    startConflictWatch?(watchId: string, trainId: string): Promise<void>
  },
  trainId: string
): Promise<void> {
  if (!ports.startConflictWatch) return
  const loaded = await ports.store.train(trainId)
  if (!loaded) return
  const { networkId } = loaded
  const cars = await ports.store.conflictWatch.unwatchedCars(trainId)
  if (cars.length) {
    const [trains, stations, networkCars, watches] = await Promise.all([
      ports.store.trains(networkId),
      ports.store.stations(networkId),
      ports.store.conflictWatch.networkCars(networkId),
      ports.store.conflictWatch.watches(networkId),
    ])
    const running = trains.map((row) => row.value)
    for (const car of cars) {
      const pairs = watchableCar(car)
        ? screenCar({
            car,
            train: loaded.value,
            trains: running,
            cars: networkCars,
            stations: stations.map((row) => row.value),
            concerns: activeConflictConcerns(watches, running),
          })
        : []
      const started = startConflictWatch({
        car,
        train: loaded.value,
        pairs,
        at: ports.now(),
      })
      try {
        await ports.store.conflictWatch.save(
          networkId,
          started.watch,
          null,
          started.events
        )
        watches.push(started.watch)
      } catch (error) {
        // A retried step, or a concurrent leg, already recorded it.
        if (!(await ports.store.conflictWatch.watch(started.watch.id)))
          throw error
      }
    }
  }
  const failures: unknown[] = []
  for (const watch of await ports.store.conflictWatch.watches(
    networkId,
    trainId
  ))
    if (watch.pairs.some(pending)) {
      try {
        await ports.startConflictWatch(watch.id, trainId)
      } catch (error) {
        // One unavailable watch must not prevent dispatching the others.
        failures.push(error)
      }
    }
  if (failures.length)
    throw new AggregateError(failures, "Conflict watch dispatch deferred")
}

const pending = (pair: ConflictPair) =>
  pair.stage === "triage" || pair.stage === "investigate"

/** Pairs still waiting, in the order the Workflow handles them. */
export async function pendingConflictPairs(
  ports: Pick<ConflictWatchPorts, "store">,
  watchId: string
): Promise<{ triage: string[]; investigate: string[] }> {
  const watch = (await ports.store.conflictWatch.watch(watchId))?.value
  const of = (stage: ConflictPair["stage"]) =>
    watch?.pairs
      .filter((pair) => pair.stage === stage)
      .map((pair) => pair.otherTrainId) ?? []
  return { triage: of("triage"), investigate: of("investigate") }
}

/** Applies a change to a watch, rereading it if another writer got there first. */
async function change(
  ports: Pick<ConflictWatchPorts, "store">,
  watchId: string,
  apply: (
    watch: ConflictWatch
  ) =>
    | { watch: ConflictWatch; events: DomainEvent[] }
    | Promise<{ watch: ConflictWatch; events: DomainEvent[] }>
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const loaded = await ports.store.conflictWatch.watch(watchId)
    if (!loaded) return
    const next = await apply(loaded.value)
    if (next.watch === loaded.value) return
    try {
      await ports.store.conflictWatch.save(
        loaded.networkId,
        next.watch,
        loaded.version,
        next.events
      )
      return
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt === 2) throw error
    }
  }
}

interface Context {
  watch: ConflictWatch
  pair: ConflictPair
  train: Train
  other: Train
  situation: ConflictSituation
  networkId: string
}

function brief(car: Car, stations: Station[]): ConflictCarBrief {
  const station = stations.find((s) => s.id === car.stationId)
  return {
    stationName: station?.name ?? car.stationId,
    goal: car.manifest.goal,
    changedPaths: car.changedPaths,
    contracts: car.manifest.contracts.map(
      (contract) => `${contract.kind}: ${contract.name} (${contract.change})`
    ),
    invariants: car.manifest.invariants,
    summary: car.agentSummary,
  }
}

/** Loads what a model needs for one pair, or null when the pair no longer applies. */
async function context(
  ports: Pick<ConflictWatchPorts, "store">,
  watchId: string,
  otherTrainId: string,
  stage: ConflictPair["stage"]
): Promise<Context | "skip" | null> {
  const loaded = await ports.store.conflictWatch.watch(watchId)
  const pair = loaded && conflictPair(loaded.value, otherTrainId)
  if (!loaded || pair?.stage !== stage) return null
  const [train, other] = await Promise.all([
    ports.store.train(loaded.value.trainId),
    ports.store.train(otherTrainId),
  ])
  if (!train || !other || isTerminal(train.value) || isTerminal(other.value))
    return "skip"
  const [car, cars, stations, line, otherLine] = await Promise.all([
    ports.store.conflictWatch.car(loaded.value.carId),
    ports.store.conflictWatch.networkCars(loaded.networkId),
    ports.store.stations(loaded.networkId),
    ports.store.line(train.value.lineId),
    ports.store.line(other.value.lineId),
  ])
  if (!car) return "skip"
  const all = stations.map((row) => row.value)
  const side = (value: Train, name: string | undefined): ConflictSide => ({
    trainId: value.id,
    lineName: name ?? value.lineId,
    cars: cars
      .filter((c) => c.trainId === value.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => brief(c, all)),
    upcoming: all
      .filter(
        (station) =>
          station.lineId === value.lineId &&
          !["complete", "cancelled"].includes(station.state.status)
      )
      .map((station) => ({
        name: station.name,
        goal: station.manifest.goal,
        expectedAreas: station.manifest.expectedAreas,
      })),
  })
  return {
    watch: loaded.value,
    pair,
    train: train.value,
    other: other.value,
    networkId: loaded.networkId,
    situation: {
      car: brief(car, all),
      train: side(train.value, line?.name),
      other: side(other.value, otherLine?.name),
      overlap: pair.overlap,
    },
  }
}

const finished =
  "A Train finished or left the network before the check; Terminus integration checks the real merge."

/** Asks the Dispatcher's Clef whether a pair without shared files deserves an investigation. */
export async function triageConflict(
  ports: ConflictWatchPorts,
  watchId: string,
  otherTrainId: string
): Promise<void> {
  const loaded = await context(ports, watchId, otherTrainId, "triage")
  if (loaded === null) return
  if (loaded === "skip")
    return change(ports, watchId, (watch) => ({
      watch: skipConflictPair(watch, otherTrainId, finished),
      events: [],
    }))
  const triage = await ports.triage.conflictRisk(loaded.situation)
  await change(ports, watchId, (watch) =>
    triageConflictPair(watch, otherTrainId, triage)
  )
}

/** A Sandbox name and Workflow-safe identity for one pair. */
export function investigationId(watchId: string, otherTrainId: string): string {
  return `${watchId}-${otherTrainId}`.replace(/[^A-Za-z0-9_-]/g, "-")
}

/** Trial-merges both Trains and has the Dispatcher examine the result. */
export async function investigateConflict(
  ports: ConflictWatchPorts,
  watchId: string,
  otherTrainId: string
): Promise<void> {
  const loaded = await context(ports, watchId, otherTrainId, "investigate")
  if (loaded === null) return
  if (loaded === "skip")
    return change(ports, watchId, (watch) => ({
      watch: skipConflictPair(watch, otherTrainId, finished),
      events: [],
    }))
  const network = await ports.store.network(loaded.networkId)
  if (!network) return
  const commits = {
    train: loaded.train.headCommit,
    other: loaded.other.headCommit,
  }
  const result = await ports.investigator.investigate({
    id: investigationId(watchId, otherTrainId),
    situation: loaded.situation,
    repositories: {
      train: { repoId: loaded.train.repoId, commit: commits.train },
      other: { repoId: loaded.other.repoId, commit: commits.other },
    },
    validation: network.validation ?? [],
  })
  const { verdict, trialMerge } = result
  const suggestedHold =
    verdict.suggestedHold === "this"
      ? loaded.train.id
      : verdict.suggestedHold === "other"
        ? otherTrainId
        : undefined
  await change(ports, watchId, (watch) =>
    concludeConflictInvestigation(
      watch,
      otherTrainId,
      {
        model: ports.investigator.model,
        commits,
        trialMerge,
        ...(result.checks ? { checks: result.checks } : {}),
        summary: verdict.summary,
        ...(verdict.conflict
          ? {
              finding: {
                kind: trialMerge && !trialMerge.clean ? "textual" : "semantic",
                summary: verdict.summary,
                paths: verdict.paths,
                details: verdict.details,
                ...(suggestedHold ? { suggestedHold } : {}),
              },
            }
          : {}),
      },
      ports.now()
    )
  )
}

/** The investigation ran out of attempts; the watch records why and reports nothing. */
export async function abandonConflictInvestigation(
  ports: Pick<ConflictWatchPorts, "store">,
  watchId: string,
  otherTrainId: string,
  reason: string
): Promise<void> {
  await change(ports, watchId, (watch) =>
    failConflictInvestigation(watch, otherTrainId, reason.slice(0, 500))
  )
}
