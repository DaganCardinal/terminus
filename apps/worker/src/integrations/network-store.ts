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
  TrainState,
  DispatchPlan,
  TechnicianRepair,
  TrainUnloadPolicy,
} from "@terminus/domain"
import {
  signalFor,
  integrateRepair,
  resolveConflict,
  rejectApprovedRepair,
} from "@terminus/domain"
import {
  technicianRepairSchema,
  trainUnloadPolicySchema,
  conductorVerdictSchema,
  type ConductorVerdict,
  stationRunResultSchema,
  validationCommandsSchema,
  integrationAttemptSchema,
  integrationInputSchema,
  integrationCandidateSchema,
  integrationResultSchema,
  evidenceSchema,
  dispatchPlanSchema,
  type IntegrationAttempt,
  type IntegrationInput,
  type IntegrationCandidate,
  type IntegrationResult,
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
  | { kind: "unload_policy"; policy: TrainUnloadPolicy; version: number | null }
  | {
      kind: "technician_repair"
      repair: TechnicianRepair
      version: number | null
    }
  | { kind: "dispatch_plan"; plan: DispatchPlan; version: number | null }
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

interface TrainRow extends RecordRow {
  state_entered_at: string | null
  previous_state: string | null
  previous_entered_at: string | null
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

  async unloadPolicy(
    trainId: string
  ): Promise<Loaded<TrainUnloadPolicy> | null> {
    const row = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM train_unload_policies WHERE id = ?"
      )
      .bind(trainId)
      .first<VersionedRow>()
    return row
      ? {
          ...loaded<TrainUnloadPolicy>(row),
          value: trainUnloadPolicySchema.parse(JSON.parse(row.record)),
        }
      : null
  }

  async unloadPolicies(networkId: string): Promise<TrainUnloadPolicy[]> {
    return (
      await this.#records<TrainUnloadPolicy>("train_unload_policies", networkId)
    ).map((policy) => trainUnloadPolicySchema.parse(policy))
  }

  async repair(id: string): Promise<Loaded<TechnicianRepair> | null> {
    const row = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM technician_repairs WHERE id = ?"
      )
      .bind(id)
      .first<VersionedRow>()
    return row
      ? {
          ...loaded<TechnicianRepair>(row),
          value: technicianRepairSchema.parse(JSON.parse(row.record)),
        }
      : null
  }

  async repairs(networkId: string): Promise<TechnicianRepair[]> {
    return (
      await this.#records<TechnicianRepair>("technician_repairs", networkId)
    ).map((repair) => technicianRepairSchema.parse(repair))
  }

  async approvedRepair(trainId: string): Promise<TechnicianRepair | null> {
    const row = await this.#db
      .prepare(
        "SELECT record FROM technician_repairs WHERE train_id = ? AND status = 'approved' ORDER BY rowid DESC LIMIT 1"
      )
      .bind(trainId)
      .first<RecordRow>()
    return row ? technicianRepairSchema.parse(JSON.parse(row.record)) : null
  }

  async dispatchPlan(id: string): Promise<Loaded<DispatchPlan> | null> {
    const row = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM dispatch_plans WHERE id = ?"
      )
      .bind(id)
      .first<VersionedRow>()
    return row
      ? {
          ...loaded<DispatchPlan>(row),
          value: dispatchPlanSchema.parse(JSON.parse(row.record)),
        }
      : null
  }

  async integration(id: string): Promise<IntegrationAttempt | null> {
    const row = await this.#db
      .prepare("SELECT * FROM integration_attempts WHERE id = ?")
      .bind(id)
      .first<IntegrationRow>()
    return row ? toIntegration(row) : null
  }

  async latestIntegration(trainId: string): Promise<IntegrationAttempt | null> {
    const row = await this.#db
      .prepare(
        "SELECT * FROM integration_attempts WHERE train_id = ? ORDER BY rowid DESC LIMIT 1"
      )
      .bind(trainId)
      .first<IntegrationRow>()
    return row ? toIntegration(row) : null
  }

  /** Report an uncertain write as a blocker, while retaining exclusive clearance. */
  async interruptIntegration(
    id: string,
    detail: string
  ): Promise<IntegrationResult> {
    const attempt = await this.integration(id)
    if (!attempt) throw new Error("Unknown integration attempt")
    if (attempt.result) return attempt.result
    const result: IntegrationResult = {
      ok: false,
      issues: [{ kind: "integration_failed", detail }],
    }
    await this.#db.batch([
      this.#db
        .prepare(
          "UPDATE integration_attempts SET result = ? WHERE id = ? AND status IN ('cleared', 'prepared') AND result IS NULL"
        )
        .bind(JSON.stringify(result), id),
      this.#integrationEvent(attempt.input, {
        type: "terminus.integration_interrupted",
        trainId: attempt.input.trainId,
        integrationId: id,
        issues: result.issues,
      }),
    ])
    return result
  }

  /** Explicit recovery keeps the candidate, evidence and reservation intact. */
  async retryIntegration(id: string): Promise<void> {
    const attempt = await this.integration(id)
    if (
      !attempt ||
      (attempt.status !== "cleared" && attempt.status !== "prepared")
    )
      throw new Error("Integration no longer holds clearance")
    if (!attempt.result) return
    await this.#db.batch([
      this.#db
        .prepare(
          "UPDATE integration_attempts SET result = NULL WHERE id = ? AND status IN ('cleared', 'prepared')"
        )
        .bind(id),
      this.#integrationEvent(attempt.input, {
        type: "terminus.integration_retried",
        trainId: attempt.input.trainId,
        integrationId: id,
      }),
    ])
  }

  async integrations(networkId: string): Promise<IntegrationAttempt[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT * FROM integration_attempts WHERE network_id = ? ORDER BY rowid"
      )
      .bind(networkId)
      .all<IntegrationRow>()
    return results.map(toIntegration)
  }

  /** Returning Trains in domain request order, without loading the event history. */
  async returningTrains(networkId: string): Promise<Loaded<Train>[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT record, version, network_id FROM trains
      WHERE network_id = ? AND status = 'returning'
      ORDER BY COALESCE((SELECT MAX(seq) FROM events WHERE train_id = trains.id
        AND type = 'terminus.integration_requested'), 9223372036854775807), id`
      )
      .bind(networkId)
      .all<VersionedRow>()
    return results.map((row) => loaded<Train>(row))
  }

  /** Atomically grants one Dispatcher clearance per network, with its event. */
  async claimIntegration(
    input: IntegrationInput
  ): Promise<IntegrationAttempt | null> {
    const validated = integrationInputSchema.parse(input)
    try {
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO integration_attempts (id, network_id, train_id, status, input, created_at)
        SELECT ?, ?, ?, 'cleared', ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM integration_attempts WHERE network_id = ? AND status IN ('cleared', 'prepared'))
        AND EXISTS (SELECT 1 FROM networks WHERE id = ? AND terminus_commit = ?)`
          )
          .bind(
            input.id,
            input.networkId,
            input.trainId,
            JSON.stringify(validated),
            new Date().toISOString(),
            input.networkId,
            input.networkId,
            input.terminusCommit
          ),
        this.#integrationEvent(input, {
          type: "terminus.clearance_granted",
          trainId: input.trainId,
          integrationId: input.id,
        }),
      ])
    } catch (error) {
      if (String(error).includes("unload_permission_required")) return null
      throw error
    }
    return this.integration(input.id)
  }

  async prepareIntegration(
    id: string,
    candidate: IntegrationCandidate,
    evidence: import("@terminus/domain").Evidence
  ): Promise<void> {
    candidate = integrationCandidateSchema.parse(candidate)
    evidence = evidenceSchema.parse(evidence)
    const attempt = await this.integration(id)
    if (!attempt) throw new Error("Unknown integration attempt")
    if (attempt.status !== "cleared") {
      if (
        JSON.stringify(attempt.candidate) !== JSON.stringify(candidate) ||
        JSON.stringify(attempt.evidence) !== JSON.stringify(evidence)
      )
        throw new Error(
          "Integration already has a different candidate or evidence"
        )
      return
    }
    await this.#db.batch([
      this.#db
        .prepare(
          "UPDATE integration_attempts SET status = 'prepared', candidate = ?, evidence = ? WHERE id = ? AND status = 'cleared'"
        )
        .bind(JSON.stringify(candidate), JSON.stringify(evidence), id),
      this.#integrationEvent(attempt.input, {
        type: "terminus.candidate_prepared",
        trainId: attempt.input.trainId,
        integrationId: id,
        mergeCommit: candidate.headCommit,
      }),
    ])
  }

  /** Called only after the canonical Git head has been confirmed. Releases clearance atomically. */
  async finishIntegration(
    id: string,
    result: IntegrationResult
  ): Promise<void> {
    const attempt = await this.integration(id)
    if (!attempt) throw new Error("Unknown integration attempt")
    const validated = integrationResultSchema.parse(result)
    if (attempt.result) {
      if (JSON.stringify(attempt.result) !== JSON.stringify(validated))
        throw new Error("Integration already has a different result")
      return
    }
    const { input } = attempt
    const statements: D1PreparedStatement[] = []
    if (validated.ok) {
      if (
        attempt.status !== "prepared" ||
        attempt.candidate?.headCommit !== validated.mergeCommit ||
        JSON.stringify(attempt.evidence) !== JSON.stringify(validated.evidence)
      )
        throw new Error("Cannot promote an unprepared candidate")
      statements.push(
        this.#db
          .prepare(
            `UPDATE networks SET terminus_commit =
        CASE WHEN terminus_commit = ? THEN ? ELSE NULL END WHERE id = ?`
          )
          .bind(input.terminusCommit, validated.mergeCommit, input.networkId)
      )
    }
    statements.push(
      this.#db
        .prepare(
          "UPDATE integration_attempts SET status = ?, result = ? WHERE id = ? AND result IS NULL"
        )
        .bind(
          validated.ok ? "completed" : "failed",
          JSON.stringify(validated),
          id
        ),
      this.#integrationEvent(
        input,
        validated.ok
          ? {
              type: "terminus.promoted",
              trainId: input.trainId,
              integrationId: id,
              mergeCommit: validated.mergeCommit,
            }
          : {
              type: "terminus.integration_failed",
              trainId: input.trainId,
              integrationId: id,
              issues: validated.issues,
            }
      )
    )
    if (validated.ok && input.repairId) {
      const loaded = await this.repair(input.repairId)
      const conflict = (await this.conflicts(input.networkId)).find(
        (item) => item.id === loaded?.value.conflictId
      )
      if (
        !loaded ||
        !conflict ||
        loaded.value.state.status !== "approved" ||
        loaded.value.state.proposal.headCommit !== validated.mergeCommit
      )
        throw new Error("Promotion does not match an approved repair")
      const repaired = integrateRepair(loaded.value, id)
      const resolved = resolveConflict(conflict)
      if (!repaired.ok || !resolved.ok)
        throw new Error("Repair cannot complete")
      const now = new Date().toISOString()
      statements.push(
        this.#statement(
          input.networkId,
          {
            kind: "technician_repair",
            repair: repaired.value,
            version: loaded.version,
          },
          now
        ),
        this.#statement(
          input.networkId,
          { kind: "conflict", conflict: resolved.value },
          now
        )
      )
      for (const event of [...repaired.events, ...resolved.events])
        statements.push(
          this.#db
            .prepare(
              "INSERT INTO events (network_id, type, train_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?)"
            )
            .bind(
              input.networkId,
              event.type,
              input.trainId,
              JSON.stringify(event),
              now
            )
        )
    }
    if (!validated.ok && !validated.holds && input.repairId) {
      const loaded = await this.repair(input.repairId)
      if (loaded?.value.state.status === "approved") {
        const rejected = rejectApprovedRepair(
          loaded.value,
          id,
          validated.issues.map((issue) => issue.detail).join("; "),
          validated.evidence
        )
        if (!rejected.ok)
          throw new Error("Repair failure could not be recorded")
        const now = new Date().toISOString()
        statements.push(
          this.#statement(
            input.networkId,
            {
              kind: "technician_repair",
              repair: rejected.value,
              version: loaded.version,
            },
            now
          )
        )
        for (const event of rejected.events)
          statements.push(
            this.#db
              .prepare(
                "INSERT INTO events (network_id, type, train_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?)"
              )
              .bind(
                input.networkId,
                event.type,
                input.trainId,
                JSON.stringify(event),
                now
              )
          )
      }
    }
    await this.#db.batch(statements)
  }

  #integrationEvent(
    input: IntegrationInput,
    event: DomainEvent
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO events (network_id, type, train_id, payload, occurred_at)
      SELECT ?, ?, ?, ?, ? WHERE changes() = 1`
      )
      .bind(
        input.networkId,
        event.type,
        input.trainId,
        JSON.stringify(event),
        new Date().toISOString()
      )
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

  async stations(networkId: NetworkId): Promise<Loaded<Station>[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT record, version, network_id FROM stations WHERE network_id = ?"
      )
      .bind(networkId)
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
      ...writes.map((write) => this.#statement(networkId, write, occurredAt)),
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
    const [
      networks,
      lines,
      stations,
      trains,
      cars,
      holds,
      conflicts,
      seq,
      plans,
      repairs,
      unloadPolicies,
    ] = await this.#db.batch([
      this.#db.prepare("SELECT * FROM networks WHERE id = ?").bind(networkId),
      select("lines"),
      select("stations"),
      this.#db
        .prepare(
          // Trains written before their timing was tracked fall back to their
          // latest event, which is when their last status change happened.
          `SELECT record, previous_state, previous_entered_at,
             COALESCE(state_entered_at, (
               SELECT max(occurred_at) FROM events
               WHERE events.network_id = trains.network_id AND events.train_id = trains.id
             )) AS state_entered_at
           FROM trains WHERE network_id = ?`
        )
        .bind(networkId),
      select("cars"),
      select("holds"),
      select("conflicts"),
      this.#db
        .prepare("SELECT max(seq) AS seq FROM events WHERE network_id = ?")
        .bind(networkId),
      select("dispatch_plans"),
      select("technician_repairs"),
      select("train_unload_policies"),
    ])
    const network = networks!.results[0] as NetworkRow | undefined
    if (!network) return null
    const records = <T>(result: D1Result | undefined) =>
      (result?.results as RecordRow[]).map((row) => parse<T>(row))
    return {
      network: toNetwork(network),
      lines: records<Line>(lines),
      stations: records<Station>(stations),
      trains: (trains!.results as TrainRow[]).map((row) => {
        const train = parse<Train>(row)
        return {
          train,
          signal: signalFor(train),
          stateEnteredAt: row.state_entered_at ?? network.created_at,
          previous:
            row.previous_state && row.previous_entered_at
              ? {
                  state: JSON.parse(row.previous_state) as TrainState,
                  enteredAt: row.previous_entered_at,
                }
              : null,
        }
      }),
      cars: records<Car>(cars).sort(
        (a, b) => a.trainId.localeCompare(b.trainId) || a.position - b.position
      ),
      holds: records<Hold>(holds),
      conflicts: records<Conflict>(conflicts),
      plans: records<DispatchPlan>(plans).map((plan) =>
        dispatchPlanSchema.parse(plan)
      ),
      repairs: records<TechnicianRepair>(repairs).map((repair) =>
        technicianRepairSchema.parse(repair)
      ),
      unloadPolicies: records<TrainUnloadPolicy>(unloadPolicies).map((policy) =>
        trainUnloadPolicySchema.parse(policy)
      ),
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

  #statement(
    networkId: NetworkId,
    write: Write,
    occurredAt: string
  ): D1PreparedStatement {
    const db = this.#db
    switch (write.kind) {
      case "unload_policy": {
        const { policy, version } = write
        const record = JSON.stringify(trainUnloadPolicySchema.parse(policy))
        return version === null
          ? db
              .prepare(
                "INSERT INTO train_unload_policies (id, network_id, record, version) VALUES (?, ?, ?, 0)"
              )
              .bind(policy.trainId, networkId, record)
          : db
              .prepare(
                "UPDATE train_unload_policies SET record = ?, version = ? WHERE id = ?"
              )
              .bind(record, version + 1, policy.trainId)
      }
      case "technician_repair": {
        const { repair, version } = write
        const record = JSON.stringify(technicianRepairSchema.parse(repair))
        if (repair.networkId !== networkId)
          throw new Error("Repair belongs to another network")
        return version === null
          ? db
              .prepare(
                "INSERT INTO technician_repairs (id, network_id, train_id, conflict_id, status, record, version) VALUES (?, ?, ?, ?, ?, ?, 0)"
              )
              .bind(
                repair.id,
                networkId,
                repair.source.trainId,
                repair.conflictId,
                repair.state.status,
                record
              )
          : db
              .prepare(
                "UPDATE technician_repairs SET status = ?, record = ?, version = ? WHERE id = ?"
              )
              .bind(repair.state.status, record, version + 1, repair.id)
      }
      case "dispatch_plan": {
        const { plan, version } = write
        const record = JSON.stringify(dispatchPlanSchema.parse(plan))
        return version === null
          ? db
              .prepare(
                "INSERT INTO dispatch_plans (id, network_id, status, record, version) VALUES (?, ?, ?, ?, 0)"
              )
              .bind(plan.id, networkId, plan.state.status, record)
          : db
              .prepare(
                "UPDATE dispatch_plans SET status = ?, record = ?, version = ? WHERE id = ?"
              )
              .bind(plan.state.status, record, version + 1, plan.id)
      }
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
                "INSERT INTO trains (id, network_id, line_id, status, record, version, state_entered_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
              )
              .bind(
                train.id,
                networkId,
                train.lineId,
                train.state.status,
                record,
                occurredAt
              )
          : db
              .prepare(
                // SET expressions read the row as it was, so a status change
                // moves the old state and its start time into previous_*.
                `UPDATE trains SET
                   previous_state = CASE WHEN status = ?1 THEN previous_state ELSE json_extract(record, '$.state') END,
                   previous_entered_at = CASE WHEN status = ?1 THEN previous_entered_at ELSE state_entered_at END,
                   state_entered_at = CASE WHEN status = ?1 THEN state_entered_at ELSE ?2 END,
                   status = ?1, record = ?3, version = ?4
                 WHERE id = ?5`
              )
              .bind(
                train.state.status,
                occurredAt,
                record,
                version + 1,
                train.id
              )
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

interface IntegrationRow {
  input: string
  status: string
  candidate: string | null
  evidence: string | null
  result: string | null
}

function toIntegration(row: IntegrationRow): IntegrationAttempt {
  return integrationAttemptSchema.parse({
    input: JSON.parse(row.input),
    status: row.status,
    candidate: row.candidate ? JSON.parse(row.candidate) : null,
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
    result: row.result ? JSON.parse(row.result) : null,
  })
}
