import type {
  Car,
  Conflict,
  DomainEvent,
  Hold,
  HoldId,
  Line,
  LineId,
  NetworkId,
  Station,
  StationId,
  StationStatus,
  Train,
  TrainId,
} from "@terminus/domain"
import { signalFor } from "@terminus/domain"
import {
  conductorVerdictSchema,
  type ConductorVerdict,
  stationRunResultSchema,
  validationCommandsSchema,
} from "@terminus/protocol"
import type {
  ReviewInput,
  StationRunInput,
  StationRunResult,
} from "@terminus/agent-runtime"
import { defaultValidation } from "./execution-config"
import type {
  EventEnvelope,
  NetworkSnapshot,
  NetworkSummary,
} from "@terminus/protocol"

/** An entity with the version and network it was read with. */
export interface Loaded<T> {
  value: T
  version: number
  networkId: NetworkId
}

/** A row write. `version` is the version read, or null to insert. */
export type Write =
  | { kind: "network"; network: NetworkSummary }
  | { kind: "line"; line: Line }
  | { kind: "station"; station: Station; version: number | null }
  | { kind: "train"; train: Train; version: number | null }
  | { kind: "car"; car: Car }
  | { kind: "hold"; hold: Hold }
  | { kind: "hold_removed"; holdId: HoldId }
  | { kind: "conflict"; conflict: Conflict }

/** Another writer changed a row between this writer's read and its write. */
export class StaleWriteError extends Error {
  constructor() {
    super("A row changed since it was read; reload and retry")
    this.name = "StaleWriteError"
  }
}

interface RecordRow {
  record: string
}

interface VersionedRow extends RecordRow {
  version: number
  network_id: string
}

interface NetworkRow {
  id: string
  name: string
  terminus_repo_id: string
  terminus_commit: string
  created_at: string
  validation: string
}

interface EventRow {
  seq: number
  network_id: string
  payload: string
  occurred_at: string
}

/** D1 persistence for network state and its event log. */
export class NetworkStore {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async conductorReview(
    input: ReviewInput,
    model: string
  ): Promise<ConductorVerdict | null> {
    const row = await this.#db
      .prepare("SELECT input, result FROM conductor_reviews WHERE id = ?")
      .bind(reviewId(input))
      .first<{ input: string; result: string }>()
    if (!row) return null
    if (row.input !== JSON.stringify({ ...input, model }))
      throw new Error(
        "Conductor review identity was reused with different input or configuration"
      )
    return conductorVerdictSchema.parse(JSON.parse(row.result))
  }

  async recordConductorReview(
    networkId: string,
    input: ReviewInput,
    model: string,
    verdict: ConductorVerdict
  ): Promise<void> {
    const validated = conductorVerdictSchema.parse(verdict)
    await this.#db
      .prepare(
        "INSERT INTO conductor_reviews (id, station_id, network_id, input, result, recorded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .bind(
        reviewId(input),
        input.stationId,
        networkId,
        JSON.stringify({ ...input, model }),
        JSON.stringify(validated),
        new Date().toISOString()
      )
      .run()
    const saved = await this.conductorReview(input, model)
    if (JSON.stringify(saved) !== JSON.stringify(validated))
      throw new Error(
        "Conductor review already has a different durable verdict"
      )
  }

  async agentCheckpoint(
    input: StationRunInput,
    model: string
  ): Promise<{ result: StationRunResult; published: boolean } | null> {
    const row = await this.#db
      .prepare("SELECT input, result, published FROM agent_runs WHERE id = ?")
      .bind(input.runId)
      .first<{ input: string; result: string; published: number }>()
    if (!row) return null
    if (row.input !== JSON.stringify({ ...input, model }))
      throw new Error(
        "Station run identity was reused with different input or configuration"
      )
    return {
      result: stationRunResultSchema.parse(JSON.parse(row.result)),
      published: row.published === 1,
    }
  }

  async agentRun(
    input: StationRunInput,
    model: string
  ): Promise<StationRunResult | null> {
    const checkpoint = await this.agentCheckpoint(input, model)
    return checkpoint?.published ? checkpoint.result : null
  }

  async recordAgentRun(
    networkId: string,
    input: StationRunInput,
    model: string,
    result: StationRunResult
  ): Promise<void> {
    const validated = stationRunResultSchema.parse(result)
    await this.#db
      .prepare(
        "INSERT INTO agent_runs (id, station_id, network_id, input, result, recorded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .bind(
        input.runId,
        input.stationId,
        networkId,
        JSON.stringify({ ...input, model }),
        JSON.stringify(validated),
        new Date().toISOString()
      )
      .run()
    const saved = await this.agentCheckpoint(input, model)
    if (JSON.stringify(saved?.result) !== JSON.stringify(validated))
      throw new Error("Station run already has a different durable result")
  }

  async publishAgentRun(input: StationRunInput, model: string): Promise<void> {
    const checkpoint = await this.agentCheckpoint(input, model)
    if (!checkpoint)
      throw new Error(
        "Station candidate has no independent evidence checkpoint"
      )
    await this.#db
      .prepare("UPDATE agent_runs SET published = 1 WHERE id = ?")
      .bind(input.runId)
      .run()
  }

  async network(id: NetworkId): Promise<NetworkSummary | null> {
    const row = await this.#db
      .prepare("SELECT * FROM networks WHERE id = ?")
      .bind(id)
      .first<NetworkRow>()
    return row ? toNetwork(row) : null
  }

  async networks(): Promise<NetworkSummary[]> {
    const { results } = await this.#db
      .prepare("SELECT * FROM networks ORDER BY created_at DESC")
      .all<NetworkRow>()
    return results.map(toNetwork)
  }

  async line(id: LineId): Promise<Line | null> {
    const row = await this.#db
      .prepare("SELECT record FROM lines WHERE id = ?")
      .bind(id)
      .first<RecordRow>()
    return row ? parse<Line>(row) : null
  }

  async train(id: TrainId): Promise<Loaded<Train> | null> {
    const row = await this.#db
      .prepare("SELECT record, version, network_id FROM trains WHERE id = ?")
      .bind(id)
      .first<VersionedRow>()
    return row ? loaded<Train>(row) : null
  }

  async trains(networkId: NetworkId): Promise<Loaded<Train>[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM trains WHERE network_id = ?"
      )
      .bind(networkId)
      .all<VersionedRow>()
    return results.map((row) => loaded<Train>(row))
  }

  async station(id: StationId): Promise<Loaded<Station> | null> {
    const row = await this.#db
      .prepare("SELECT record, version, network_id FROM stations WHERE id = ?")
      .bind(id)
      .first<VersionedRow>()
    return row ? loaded<Station>(row) : null
  }

  async lineStations(lineId: LineId): Promise<Loaded<Station>[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM stations WHERE line_id = ?"
      )
      .bind(lineId)
      .all<VersionedRow>()
    return results.map((row) => loaded<Station>(row))
  }

  /** Current statuses of the given Stations, on any Line. Unknown ids are absent. */
  async stationStatuses(
    ids: StationId[]
  ): Promise<Partial<Record<StationId, StationStatus>>> {
    if (ids.length === 0) return {}
    const { results } = await this.#db
      .prepare(
        `SELECT id, status FROM stations WHERE id IN (${ids.map(() => "?").join(", ")})`
      )
      .bind(...ids)
      .all<{ id: string; status: StationStatus }>()
    return Object.fromEntries(results.map((row) => [row.id, row.status]))
  }

  async holds(networkId: NetworkId): Promise<Hold[]> {
    return this.#records<Hold>("holds", networkId)
  }

  async conflicts(networkId: NetworkId): Promise<Conflict[]> {
    return this.#records<Conflict>("conflicts", networkId)
  }

  /** How many times a Station has been signaled. Each signal starts a new run. */
  async signalCount(stationId: StationId): Promise<number> {
    const row = await this.#db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE station_id = ? AND type = 'station.signaled'"
      )
      .bind(stationId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  /**
   * Applies writes and appends their events in one atomic batch. Throws
   * StaleWriteError if any versioned row changed since it was read.
   */
  async commit(
    networkId: NetworkId,
    writes: Write[],
    events: DomainEvent[]
  ): Promise<void> {
    const occurredAt = new Date().toISOString()
    const statements = [
      ...writes.map((write) => this.#statement(networkId, write)),
      ...events.map((event) =>
        this.#db
          .prepare(
            "INSERT INTO events (network_id, type, train_id, station_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(
            networkId,
            event.type,
            "trainId" in event ? event.trainId : null,
            "stationId" in event ? event.stationId : null,
            JSON.stringify(event),
            occurredAt
          )
      ),
    ]
    if (statements.length === 0) return
    try {
      await this.#db.batch(statements)
    } catch (error) {
      if (String(error).includes("stale_write")) throw new StaleWriteError()
      throw error
    }
  }

  async eventsAfter(
    networkId: NetworkId,
    after: number,
    limit = 500
  ): Promise<EventEnvelope[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT seq, network_id, payload, occurred_at FROM events WHERE network_id = ? AND seq > ? ORDER BY seq LIMIT ?"
      )
      .bind(networkId, after, limit)
      .all<EventRow>()
    return results.map(toEnvelope)
  }

  async lastSeq(networkId: NetworkId): Promise<number> {
    const row = await this.#db
      .prepare("SELECT max(seq) AS seq FROM events WHERE network_id = ?")
      .bind(networkId)
      .first<{ seq: number | null }>()
    return row?.seq ?? 0
  }

  /** A consistent read of the whole network. */
  async snapshot(networkId: NetworkId): Promise<NetworkSnapshot | null> {
    const select = (table: string) =>
      this.#db
        .prepare(`SELECT record FROM ${table} WHERE network_id = ?`)
        .bind(networkId)
    const [networks, lines, stations, trains, cars, holds, conflicts, seq] =
      await this.#db.batch([
        this.#db.prepare("SELECT * FROM networks WHERE id = ?").bind(networkId),
        select("lines"),
        select("stations"),
        select("trains"),
        select("cars"),
        select("holds"),
        select("conflicts"),
        this.#db
          .prepare("SELECT max(seq) AS seq FROM events WHERE network_id = ?")
          .bind(networkId),
      ])
    const network = networks!.results[0] as NetworkRow | undefined
    if (!network) return null
    const records = <T>(result: D1Result | undefined) =>
      (result?.results as RecordRow[]).map((row) => parse<T>(row))
    return {
      network: toNetwork(network),
      lines: records<Line>(lines),
      stations: records<Station>(stations),
      trains: records<Train>(trains).map((train) => ({
        train,
        signal: signalFor(train),
      })),
      cars: records<Car>(cars).sort(
        (a, b) => a.trainId.localeCompare(b.trainId) || a.position - b.position
      ),
      holds: records<Hold>(holds),
      conflicts: records<Conflict>(conflicts),
      lastSeq: (seq!.results[0] as { seq: number | null }).seq ?? 0,
    }
  }

  async #records<T>(table: string, networkId: NetworkId): Promise<T[]> {
    const { results } = await this.#db
      .prepare(`SELECT record FROM ${table} WHERE network_id = ?`)
      .bind(networkId)
      .all<RecordRow>()
    return results.map((row) => parse<T>(row))
  }

  #statement(networkId: NetworkId, write: Write): D1PreparedStatement {
    const db = this.#db
    switch (write.kind) {
      case "network": {
        const { network } = write
        return db
          .prepare(
            "INSERT INTO networks (id, name, terminus_repo_id, terminus_commit, created_at, validation) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(
            network.id,
            network.name,
            network.terminusRepoId,
            network.terminusCommit,
            network.createdAt,
            JSON.stringify(network.validation ?? defaultValidation)
          )
      }
      case "line":
        return db
          .prepare(
            "INSERT INTO lines (id, network_id, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record"
          )
          .bind(write.line.id, networkId, JSON.stringify(write.line))
      case "station": {
        const { station, version } = write
        const record = JSON.stringify(station)
        return version === null
          ? db
              .prepare(
                "INSERT INTO stations (id, network_id, line_id, status, record, version) VALUES (?, ?, ?, ?, ?, 0)"
              )
              .bind(
                station.id,
                networkId,
                station.lineId,
                station.state.status,
                record
              )
          : db
              .prepare(
                "UPDATE stations SET status = ?, record = ?, version = ? WHERE id = ?"
              )
              .bind(station.state.status, record, version + 1, station.id)
      }
      case "train": {
        const { train, version } = write
        const record = JSON.stringify(train)
        return version === null
          ? db
              .prepare(
                "INSERT INTO trains (id, network_id, line_id, status, record, version) VALUES (?, ?, ?, ?, ?, 0)"
              )
              .bind(
                train.id,
                networkId,
                train.lineId,
                train.state.status,
                record
              )
          : db
              .prepare(
                "UPDATE trains SET status = ?, record = ?, version = ? WHERE id = ?"
              )
              .bind(train.state.status, record, version + 1, train.id)
      }
      case "car":
        return db
          .prepare(
            "INSERT INTO cars (id, network_id, train_id, record) VALUES (?, ?, ?, ?)"
          )
          .bind(
            write.car.id,
            networkId,
            write.car.trainId,
            JSON.stringify(write.car)
          )
      case "hold":
        return db
          .prepare(
            "INSERT INTO holds (id, network_id, record) VALUES (?, ?, ?)"
          )
          .bind(write.hold.id, networkId, JSON.stringify(write.hold))
      case "hold_removed":
        return db.prepare("DELETE FROM holds WHERE id = ?").bind(write.holdId)
      case "conflict":
        return db
          .prepare(
            "INSERT INTO conflicts (id, network_id, status, record) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, record = excluded.record"
          )
          .bind(
            write.conflict.id,
            networkId,
            write.conflict.status,
            JSON.stringify(write.conflict)
          )
    }
  }
}

function parse<T>(row: RecordRow): T {
  return JSON.parse(row.record) as T
}

function loaded<T>(row: VersionedRow): Loaded<T> {
  return {
    value: parse<T>(row),
    version: row.version,
    networkId: row.network_id,
  }
}

function toNetwork(row: NetworkRow): NetworkSummary {
  return {
    id: row.id,
    name: row.name,
    terminusRepoId: row.terminus_repo_id,
    terminusCommit: row.terminus_commit,
    createdAt: row.created_at,
    validation: validationCommandsSchema.parse(JSON.parse(row.validation)),
  }
}

function toEnvelope(row: EventRow): EventEnvelope {
  return {
    seq: row.seq,
    networkId: row.network_id,
    occurredAt: row.occurred_at,
    event: JSON.parse(row.payload) as DomainEvent,
  }
}

function reviewId(input: ReviewInput): string {
  return JSON.stringify([
    input.stationId,
    input.trainHead,
    input.proposal.headCommit,
    input.revisionCount,
  ])
}
