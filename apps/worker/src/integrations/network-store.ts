import { EngineerStore } from "./engineer-store"
import { ConflictWatchStore } from "./conflict-watch-store"
import {
  conflictWatchSchema,
  engineerAssessmentSchema,
  engineerNoticeSchema,
  type EngineerAssessment,
} from "@terminus/protocol"
import type { ConflictWatch, EngineerNotice } from "@terminus/domain"
import type {
  AgentConfig,
  Junction,
  Crossing,
  StationCheckpoint,
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
  activeConflictConcerns,
  signalFor,
  lineStops,
  integrateRepair,
  resolveConflict,
  rejectApprovedRepair,
} from "@terminus/domain"
import {
  lineIdentities,
  roleExecutions,
  roleExecutionsSchema,
  type RoleExecutions,
  junctionSchema,
  technicianRepairSchema,
  trainUnloadPolicySchema,
  crossingSchema,
  checkpointSchema,
  stationVerdictSchema,
  type StationVerdict,
  stationRunResultSchema,
  validationCommandsSchema,
  integrationAttemptSchema,
  integrationInputSchema,
  integrationCandidateSchema,
  integrationResultSchema,
  evidenceSchema,
  dispatchPlanSchema,
  modelSettingsSchema,
  effectiveRoleModels,
  DEFAULT_MODEL_SETTINGS,
  type GeneralModelSettings,
  type ModelSettings,
  type NetworkModelSettings,
  sandboxLimitsSchema,
  DEFAULT_SANDBOX_LIMITS,
  type GeneralSandboxLimits,
  type NetworkSandboxLimits,
  type SandboxLimits,
  type RoleModels,
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
import { DispatchDraftStore } from "./dispatch-draft-store"
import type {
  EventEnvelope,
  NetworkSnapshot,
  NetworkActivity,
  NetworkListing,
  NetworkSummary,
  TerminusPublication,
} from "@terminus/protocol"

const GENERAL_SCOPE = "general"
const networkScope = (networkId: NetworkId) => `network:${networkId}`

/** An entity with the version and network it was read with. */
export interface Loaded<T> {
  value: T
  version: number
  networkId: NetworkId
}

/** A row write. `version` is the version read, or null to insert. */
export type Write =
  | { kind: "engineer_assessment"; assessment: EngineerAssessment }
  | { kind: "engineer_notice"; notice: EngineerNotice; version: number | null }
  | { kind: "conflict_watch"; watch: ConflictWatch; version: number | null }
  | { kind: "junction"; junction: Junction; version: number | null }
  | { kind: "junction_ack"; integrationId: string }
  | { kind: "junction_command_consumed"; junctionId: string }
  | { kind: "siding_consumed"; trainId: string }
  | { kind: "crossing"; crossing: Crossing; version: number | null }
  | { kind: "checkpoint"; checkpoint: StationCheckpoint }
  | { kind: "unload_policy"; policy: TrainUnloadPolicy; version: number | null }
  | {
      kind: "technician_repair"
      repair: TechnicianRepair
      version: number | null
    }
  | { kind: "dispatch_plan"; plan: DispatchPlan; version: number | null }
  /** Starts a revision from the revised plan's saved draft. */
  | { kind: "dispatch_draft_copy"; fromPlanId: string; toPlanId: string }
  | { kind: "network"; network: NetworkSummary; projectSource?: string }
  | {
      kind: "publication"
      publication: Omit<TerminusPublication, "siteUrl">
    }
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
  deleting: number
  id: string
  name: string
  terminus_repo_id: string
  terminus_commit: string
  created_at: string
  validation: string
  source_url: string | null
  publish_repo_id: string | null
  published_commit: string | null
  published_at: string | null
  site_url: string | null
}

interface NetworkListingRow extends NetworkRow {
  line_count: number
  train_counts: string | null
  junction_counts: string | null
  station_total: number
  station_complete: number
  car_count: number
  open_conflicts: number
  plans_ready: number
  last_event_at: string | null
  last_promotion: string | null
  promotions: number
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
  readonly engineer: EngineerStore
  readonly conflictWatch: ConflictWatchStore
  readonly #db: D1Database
  readonly #creationExecutions?: RoleExecutions

  constructor(db: D1Database, creationExecutions?: RoleExecutions) {
    this.#db = db
    this.engineer = new EngineerStore(db, (networkId, writes, events) =>
      this.commit(networkId, writes, events)
    )
    this.conflictWatch = new ConflictWatchStore(
      db,
      (networkId, writes, events) => this.commit(networkId, writes, events)
    )
    this.#creationExecutions = creationExecutions
  }

  async requestSiding(trainId: string, reason: string): Promise<boolean> {
    await this.#db
      .prepare(
        `INSERT INTO train_siding_requests(id,reason) SELECT ?,? WHERE NOT EXISTS
      (SELECT 1 FROM integration_attempts WHERE train_id=? AND status IN ('cleared','prepared'))
      AND EXISTS (SELECT 1 FROM trains WHERE id=? AND
        (status IN ('ready','held','blocked') OR (status='returning' AND json_extract(record,'$.state.phase')='awaiting_clearance')))
      ON CONFLICT(id) DO NOTHING`
      )
      .bind(trainId, reason, trainId, trainId)
      .run()
    return (await this.sidingRequest(trainId)) !== null
  }
  async sidingRequest(trainId: string): Promise<string | null> {
    const row = await this.#db
      .prepare("SELECT reason FROM train_siding_requests WHERE id=?")
      .bind(trainId)
      .first<{ reason: string }>()
    return row?.reason ?? null
  }
  async crossing(id: string): Promise<Loaded<Crossing> | null> {
    const row = await this.#db
      .prepare("SELECT record,version,network_id FROM crossings WHERE id=?")
      .bind(id)
      .first<VersionedRow>()
    return row
      ? {
          ...loaded<Crossing>(row),
          value: crossingSchema.parse(JSON.parse(row.record)),
        }
      : null
  }
  async crossings(networkId: string): Promise<Crossing[]> {
    return (await this.#records<Crossing>("crossings", networkId)).map((c) =>
      crossingSchema.parse(c)
    )
  }
  async checkpoint(id: string): Promise<StationCheckpoint | null> {
    const row = await this.#db
      .prepare("SELECT record FROM station_checkpoints WHERE id=?")
      .bind(id)
      .first<RecordRow>()
    return row ? checkpointSchema.parse(JSON.parse(row.record)) : null
  }
  async crossingAttempts(id: string): Promise<IntegrationAttempt[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT * FROM integration_attempts WHERE purpose='crossing' AND json_extract(input,'$.crossingId')=? ORDER BY rowid"
      )
      .bind(id)
      .all<IntegrationRow>()
    return results.map(toIntegration)
  }
  async recordIntegrationDiff(id: string, diff: string): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE integration_attempts SET diff=? WHERE id=? AND status='prepared' AND diff IS NULL"
      )
      .bind(diff, id)
      .run()
  }
  async recordIntegrationReview(
    id: string,
    review: NonNullable<IntegrationAttempt["review"]>,
    diff: string
  ): Promise<void> {
    const attempt = await this.integration(id)
    if (!attempt) throw new Error("Unknown integration attempt")
    const statements = [
      this.#db
        .prepare(
          "UPDATE integration_attempts SET review=?,diff=? WHERE id=? AND review IS NULL AND status='prepared'"
        )
        .bind(JSON.stringify(review), diff, id),
    ]
    if (attempt.input.purpose === "junction")
      statements.push(
        this.#integrationEvent(attempt.input, {
          type: "junction.integration_reviewed",
          junctionId: attempt.input.junctionId!,
          trainId: attempt.input.trainId,
          integrationId: id,
        })
      )
    await this.#db.batch(statements)
  }
  async junction(id: string): Promise<Loaded<Junction> | null> {
    const row = await this.#db
      .prepare("SELECT record,version,network_id FROM junctions WHERE id=?")
      .bind(id)
      .first<VersionedRow>()
    return row
      ? {
          ...loaded<Junction>(row),
          value: junctionSchema.parse(JSON.parse(row.record)),
        }
      : null
  }
  async junctions(networkId: string): Promise<Junction[]> {
    return (await this.#records<Junction>("junctions", networkId)).map((j) =>
      junctionSchema.parse(j)
    )
  }
  async junctionCommand(id: string): Promise<{
    release_commit: string | null
    retry: number
    abandon_reason: string | null
  } | null> {
    return this.#db
      .prepare(
        "SELECT release_commit,retry,abandon_reason FROM junction_commands WHERE id=?"
      )
      .bind(id)
      .first()
  }
  async commandJunction(
    id: string,
    command: { commit?: string; retry?: boolean; reason?: string }
  ): Promise<void> {
    if (command.commit) {
      const junction = await this.junction(id)
      if (
        junction?.value.state.status === "released" &&
        junction.value.state.commit === command.commit
      )
        return
      if (
        junction?.value.state.status !== "ready" ||
        junction.value.headCommit !== command.commit
      )
        throw new Error("junction_release_stale")
      const existing = await this.junctionCommand(id)
      if (existing?.release_commit === command.commit) return
      await this.#db.batch([
        this.#event(
          junction.networkId,
          {
            type: "junction.release_approved",
            junctionId: id,
            mergeCommit: command.commit,
          },
          new Date().toISOString(),
          {
            guard: {
              sql: "NOT EXISTS (SELECT 1 FROM junction_commands WHERE id=? AND release_commit=?)",
              params: [id, command.commit],
            },
          }
        ),
        this.#db
          .prepare(
            "INSERT INTO junction_commands(id,release_commit) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET release_commit=excluded.release_commit"
          )
          .bind(id, command.commit),
      ])
    } else
      await this.#db
        .prepare(
          "INSERT INTO junction_commands(id,retry,abandon_reason) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET retry=excluded.retry,abandon_reason=excluded.abandon_reason"
        )
        .bind(id, command.retry ? 1 : 0, command.reason ?? null)
        .run()
  }
  async requestJunctionEntry(junctionId: string, train: Train): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO junction_entries(junction_id,train_id,source_commit) VALUES (?,?,?) ON CONFLICT(junction_id,train_id) DO NOTHING"
      )
      .bind(junctionId, train.id, train.headCommit)
      .run()
  }
  async junctionEntries(
    id: string
  ): Promise<{ trainId: string; commit: string }[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT train_id,source_commit FROM junction_entries WHERE junction_id=? ORDER BY seq"
      )
      .bind(id)
      .all<{ train_id: string; source_commit: string }>()
    return results.map((r) => ({
      trainId: r.train_id,
      commit: r.source_commit,
    }))
  }
  async claimJunctionIntegration(
    input: IntegrationInput
  ): Promise<IntegrationAttempt | null> {
    const validated = integrationInputSchema.parse(input)
    await this.#db
      .prepare(
        `INSERT INTO integration_attempts(id,network_id,train_id,status,input,created_at,purpose,target_repo_id)
      SELECT ?,?,?,'cleared',?,?,'junction',? WHERE NOT EXISTS (SELECT 1 FROM integration_attempts WHERE target_repo_id=? AND status IN ('cleared','prepared'))
      AND EXISTS (SELECT 1 FROM junctions WHERE id=? AND json_extract(record,'$.headCommit')=? AND json_extract(record,'$.state.status') IN ('collecting','blocked'))
      ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        input.id,
        input.networkId,
        input.trainId,
        JSON.stringify(validated),
        new Date().toISOString(),
        input.terminusRepoId,
        input.terminusRepoId,
        input.junctionId,
        input.terminusCommit
      )
      .run()
    return this.integration(input.id)
  }
  async claimCrossingIntegration(
    input: IntegrationInput
  ): Promise<IntegrationAttempt | null> {
    const validated = integrationInputSchema.parse(input)
    await this.#db
      .prepare(
        `INSERT INTO integration_attempts(id,network_id,train_id,status,input,created_at,purpose,target_repo_id)
      SELECT ?,?,?,'cleared',?,?,'crossing',? WHERE NOT EXISTS
      (SELECT 1 FROM integration_attempts WHERE target_repo_id=? AND status IN ('cleared','prepared'))
      AND EXISTS(SELECT 1 FROM trains WHERE id=? AND json_extract(record,'$.headCommit')=? AND json_extract(record,'$.state.crossingId')=?)`
      )
      .bind(
        input.id,
        input.networkId,
        input.trainId,
        JSON.stringify(validated),
        new Date().toISOString(),
        input.terminusRepoId,
        input.terminusRepoId,
        input.trainId,
        input.terminusCommit,
        input.crossingId
      )
      .run()
    return this.integration(input.id)
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
        "SELECT record, version, network_id FROM technician_repairs WHERE id = ?1 UNION ALL SELECT record,version,network_id FROM junction_repairs WHERE id=?1"
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
    return [
      ...(await this.#records<TechnicianRepair>(
        "technician_repairs",
        networkId
      )),
      ...(await this.#records<TechnicianRepair>("junction_repairs", networkId)),
    ].map((repair) => technicianRepairSchema.parse(repair))
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
        "SELECT * FROM integration_attempts WHERE train_id = ? AND purpose = 'terminus' ORDER BY rowid DESC LIMIT 1"
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

  /** Whether a promotion into `targetRepoId` holds its exclusive reservation. */
  async hasActiveIntegration(targetRepoId: string): Promise<boolean> {
    // Matches the partial unique index that enforces the reservation.
    const row = await this.#db
      .prepare(
        `SELECT 1 FROM integration_attempts
      WHERE COALESCE(target_repo_id, json_extract(input, '$.terminusRepoId')) = ?
      AND status IN ('cleared', 'prepared') LIMIT 1`
      )
      .bind(targetRepoId)
      .first()
    return row !== null
  }

  async trainCars(trainId: string): Promise<Car[]> {
    const { results } = await this.#db
      .prepare("SELECT record FROM cars WHERE train_id = ?")
      .bind(trainId)
      .all<RecordRow>()
    return results.map((row) => parse<Car>(row))
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
            `INSERT INTO integration_attempts (id, network_id, train_id, status, input, created_at, target_repo_id)
        SELECT ?, ?, ?, 'cleared', ?, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM integration_attempts WHERE target_repo_id = ? AND status IN ('cleared', 'prepared'))
        AND EXISTS (SELECT 1 FROM networks WHERE id = ? AND terminus_commit = ?)`
          )
          .bind(
            input.id,
            input.networkId,
            input.trainId,
            JSON.stringify(validated),
            new Date().toISOString(),
            input.terminusRepoId,
            input.terminusRepoId,
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
    if (
      validated.ok &&
      (input.purpose === "crossing" || input.purpose === "junction") &&
      attempt.review?.verdict !== "accept"
    )
      throw new Error("Crossing promotion has no receiving approval")
    const statements: D1PreparedStatement[] = []
    if (validated.ok) {
      if (
        attempt.status !== "prepared" ||
        attempt.candidate?.headCommit !== validated.mergeCommit ||
        JSON.stringify(attempt.evidence) !== JSON.stringify(validated.evidence)
      )
        throw new Error("Cannot promote an unprepared candidate")
      if ((input.purpose ?? "terminus") === "terminus")
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
          validated.ok
            ? input.purpose === "junction"
              ? "prepared"
              : "completed"
            : "failed",
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
    if (validated.ok && input.repairId && input.purpose !== "junction") {
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
          this.#event(input.networkId, event, now, { trainId: input.trainId })
        )
    }
    if (
      !validated.ok &&
      !validated.holds &&
      input.repairId &&
      input.purpose !== "junction"
    ) {
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
            this.#event(input.networkId, event, now, { trainId: input.trainId })
          )
      }
    }
    await this.#db.batch(statements)
  }

  #integrationEvent(
    input: IntegrationInput,
    event: DomainEvent
  ): D1PreparedStatement {
    if (input.purpose === "crossing") return this.#db.prepare("SELECT 1")
    if (input.purpose === "junction" && !event.type.startsWith("junction.")) {
      const names: Partial<Record<DomainEvent["type"], DomainEvent["type"]>> = {
        "terminus.candidate_prepared": "junction.candidate_prepared",
        "terminus.promoted": "junction.promotion_confirmed",
        "terminus.integration_failed": "junction.integration_failed",
        "terminus.integration_interrupted": "junction.integration_interrupted",
        "terminus.integration_retried": "junction.integration_retried",
      }
      const type = names[event.type]
      if (!type)
        throw new Error(`Unexpected Junction integration event ${event.type}`)
      event = { ...event, type, junctionId: input.junctionId! } as DomainEvent
    }
    return this.#event(input.networkId, event, new Date().toISOString(), {
      trainId: input.trainId,
      guard: { sql: "changes() = 1", params: [] },
    })
  }

  /**
   * Appends one event. Its Train and Station columns come from the payload;
   * `trainId` tags an event whose payload names no Train. A `guard` is an SQL
   * condition the insert also requires.
   */
  #event(
    networkId: NetworkId,
    event: DomainEvent,
    occurredAt: string,
    options: {
      trainId?: string
      guard?: { sql: string; params: unknown[] }
    } = {}
  ): D1PreparedStatement {
    const { trainId, guard } = options
    const insert =
      "INSERT INTO events (network_id, type, train_id, station_id, payload, occurred_at) SELECT ?, ?, ?, ?, ?, ?"
    return this.#db
      .prepare(guard ? `${insert} WHERE ${guard.sql}` : insert)
      .bind(
        networkId,
        event.type,
        "trainId" in event ? event.trainId : (trainId ?? null),
        "stationId" in event ? event.stationId : null,
        JSON.stringify(event),
        occurredAt,
        ...(guard?.params ?? [])
      )
  }

  async conductorReview(
    input: ReviewInput,
    model: string | AgentConfig
  ): Promise<StationVerdict | null> {
    const row = await this.#db
      .prepare("SELECT input, result FROM conductor_reviews WHERE id = ?")
      .bind(reviewId(input))
      .first<{ input: string; result: string }>()
    if (!row) return null
    if (!sameExecutionInput(row.input, input, model))
      throw new Error(
        "Conductor review identity was reused with different input or configuration"
      )
    return stationVerdictSchema.parse(JSON.parse(row.result))
  }

  async recordConductorReview(
    networkId: string,
    input: ReviewInput,
    model: string | AgentConfig,
    verdict: StationVerdict
  ): Promise<void> {
    const validated = stationVerdictSchema.parse(verdict)
    await this.#db
      .prepare(
        "INSERT INTO conductor_reviews (id, station_id, network_id, input, result, recorded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .bind(
        reviewId(input),
        input.stationId,
        networkId,
        executionInput(input, model),
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
    model: string | AgentConfig
  ): Promise<{ result: StationRunResult; published: boolean } | null> {
    const row = await this.#db
      .prepare("SELECT input, result, published FROM agent_runs WHERE id = ?")
      .bind(input.runId)
      .first<{ input: string; result: string; published: number }>()
    if (!row) return null
    if (!sameExecutionInput(row.input, input, model))
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
    model: string | AgentConfig
  ): Promise<StationRunResult | null> {
    const checkpoint = await this.agentCheckpoint(input, model)
    return checkpoint?.published ? checkpoint.result : null
  }

  async recordAgentRun(
    networkId: string,
    input: StationRunInput,
    model: string | AgentConfig,
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
        executionInput(input, model),
        JSON.stringify(validated),
        new Date().toISOString()
      )
      .run()
    const saved = await this.agentCheckpoint(input, model)
    if (JSON.stringify(saved?.result) !== JSON.stringify(validated))
      throw new Error("Station run already has a different durable result")
  }

  async publishAgentRun(
    input: StationRunInput,
    model: string | AgentConfig
  ): Promise<void> {
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

  /** The General model settings, or the defaults until someone saves them. */
  async generalModelSettings(): Promise<GeneralModelSettings> {
    const rows = await this.#modelSettingRows(GENERAL_SCOPE)
    const general = rows.get(GENERAL_SCOPE)
    return {
      settings: general?.settings ?? DEFAULT_MODEL_SETTINGS,
      updatedAt: general?.updatedAt ?? null,
    }
  }

  async setGeneralModelSettings(
    settings: ModelSettings,
    now: string
  ): Promise<GeneralModelSettings> {
    await this.#db
      .prepare(
        "INSERT INTO model_settings (scope, network_id, settings, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(scope) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at"
      )
      .bind(GENERAL_SCOPE, JSON.stringify(settings), now)
      .run()
    return this.generalModelSettings()
  }

  async networkModelSettings(
    networkId: NetworkId
  ): Promise<NetworkModelSettings> {
    const scope = networkScope(networkId)
    const rows = await this.#modelSettingRows(GENERAL_SCOPE, scope)
    const override = rows.get(scope)
    return {
      override: override?.settings ?? null,
      general: rows.get(GENERAL_SCOPE)?.settings ?? DEFAULT_MODEL_SETTINGS,
      updatedAt: override?.updatedAt ?? null,
    }
  }

  /** Null removes the override so the network follows General again. */
  async setNetworkModelSettings(
    networkId: NetworkId,
    override: ModelSettings | null,
    now: string
  ): Promise<NetworkModelSettings> {
    const scope = networkScope(networkId)
    await (
      override
        ? this.#db
            .prepare(
              "INSERT INTO model_settings (scope, network_id, settings, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at"
            )
            .bind(scope, networkId, JSON.stringify(override), now)
        : this.#db
            .prepare("DELETE FROM model_settings WHERE scope = ?")
            .bind(scope)
    ).run()
    return this.networkModelSettings(networkId)
  }

  /** The General Sandbox limits, or the defaults until someone saves them. */
  async generalSandboxLimits(): Promise<GeneralSandboxLimits> {
    const general = (await this.#sandboxLimitRows(GENERAL_SCOPE)).get(
      GENERAL_SCOPE
    )
    return {
      limits: general?.limits ?? DEFAULT_SANDBOX_LIMITS,
      updatedAt: general?.updatedAt ?? null,
    }
  }

  async setGeneralSandboxLimits(
    limits: SandboxLimits,
    now: string
  ): Promise<GeneralSandboxLimits> {
    await this.#db
      .prepare(
        "INSERT INTO sandbox_limits (scope, network_id, limits, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(scope) DO UPDATE SET limits = excluded.limits, updated_at = excluded.updated_at"
      )
      .bind(GENERAL_SCOPE, JSON.stringify(limits), now)
      .run()
    return this.generalSandboxLimits()
  }

  async networkSandboxLimits(
    networkId: NetworkId
  ): Promise<NetworkSandboxLimits> {
    const scope = networkScope(networkId)
    const rows = await this.#sandboxLimitRows(GENERAL_SCOPE, scope)
    const override = rows.get(scope)
    return {
      override: override?.limits ?? null,
      general: rows.get(GENERAL_SCOPE)?.limits ?? DEFAULT_SANDBOX_LIMITS,
      updatedAt: override?.updatedAt ?? null,
    }
  }

  /** Null removes the override so the network follows General again. */
  async setNetworkSandboxLimits(
    networkId: NetworkId,
    override: SandboxLimits | null,
    now: string
  ): Promise<NetworkSandboxLimits> {
    const scope = networkScope(networkId)
    await (
      override
        ? this.#db
            .prepare(
              "INSERT INTO sandbox_limits (scope, network_id, limits, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET limits = excluded.limits, updated_at = excluded.updated_at"
            )
            .bind(scope, networkId, JSON.stringify(override), now)
        : this.#db
            .prepare("DELETE FROM sandbox_limits WHERE scope = ?")
            .bind(scope)
    ).run()
    return this.networkSandboxLimits(networkId)
  }

  async #sandboxLimitRows(
    ...scopes: string[]
  ): Promise<Map<string, { limits: SandboxLimits; updatedAt: string }>> {
    const { results } = await this.#db
      .prepare(
        `SELECT scope, limits, updated_at FROM sandbox_limits WHERE scope IN (${scopes.map(() => "?").join(", ")})`
      )
      .bind(...scopes)
      .all<{ scope: string; limits: string; updated_at: string }>()
    return new Map(
      results.map((row) => [
        row.scope,
        {
          limits: sandboxLimitsSchema.parse(JSON.parse(row.limits)),
          updatedAt: row.updated_at,
        },
      ])
    )
  }

  /** Immutable work configuration, separate from lifecycle state. */
  async executionConfig(
    kind: "train" | "dispatch_plan" | "technician_repair" | "junction",
    id: string
  ): Promise<RoleExecutions | null> {
    const row = await this.#db
      .prepare(
        "SELECT config FROM execution_configs WHERE kind = ? AND work_id = ?"
      )
      .bind(kind, id)
      .first<{ config: string }>()
    return row ? roleExecutionsSchema.parse(JSON.parse(row.config)) : null
  }

  async networkExecutions(networkId: string): Promise<RoleExecutions> {
    const settings = await this.networkModelSettings(networkId)
    return roleExecutions(settings.override ?? settings.general)
  }

  /** The models a network's roles run with, as of now. */
  async roleModels(networkId: NetworkId): Promise<RoleModels> {
    return effectiveRoleModels(await this.networkModelSettings(networkId))
  }

  async #modelSettingRows(
    ...scopes: string[]
  ): Promise<Map<string, { settings: ModelSettings; updatedAt: string }>> {
    const { results } = await this.#db
      .prepare(
        `SELECT scope, settings, updated_at FROM model_settings WHERE scope IN (${scopes.map(() => "?").join(", ")})`
      )
      .bind(...scopes)
      .all<{ scope: string; settings: string; updated_at: string }>()
    return new Map(
      results.map((row) => [
        row.scope,
        {
          settings: modelSettingsSchema.parse(JSON.parse(row.settings)),
          updatedAt: row.updated_at,
        },
      ])
    )
  }

  async network(id: NetworkId): Promise<NetworkSummary | null> {
    const row = await this.#db
      .prepare("SELECT * FROM networks WHERE id = ?")
      .bind(id)
      .first<NetworkRow>()
    return row ? toNetwork(row) : null
  }

  /** The live site URL is information the user enters; it changes no state. */
  async setPublishedSite(
    networkId: NetworkId,
    siteUrl: string | null
  ): Promise<void> {
    await this.assertActive(networkId)
    await this.#db
      .prepare("UPDATE networks SET site_url = ? WHERE id = ?")
      .bind(siteUrl, networkId)
      .run()
  }

  async assertActive(networkId: string): Promise<void> {
    const row = await this.#db
      .prepare("SELECT deleting FROM networks WHERE id = ?")
      .bind(networkId)
      .first<{ deleting: number }>()
    if (!row) throw new Error("Unknown network")
    if (row.deleting) throw new Error("network_deleting")
  }

  /** The Network for an imported project, by its normalized source URL. */
  async networkForProject(
    projectSource: string
  ): Promise<NetworkSummary | null> {
    const row = await this.#db
      .prepare("SELECT * FROM networks WHERE project_source = ?")
      .bind(projectSource)
      .first<NetworkRow>()
    return row ? toNetwork(row) : null
  }

  async networks(): Promise<NetworkSummary[]> {
    const { results } = await this.#db
      .prepare("SELECT * FROM networks ORDER BY created_at DESC")
      .all<NetworkRow>()
    return results.map(toNetwork)
  }

  /** Networks with the activity the networks list shows, in one query. */
  async networkListings(networkId?: NetworkId): Promise<NetworkListing[]> {
    const statement = this.#db.prepare(
      `SELECT n.*,
          (SELECT COUNT(*) FROM lines WHERE network_id = n.id) AS line_count,
          (SELECT json_group_object(status,total) FROM (SELECT json_extract(record,'$.state.status') AS status, COUNT(*) AS total FROM junctions WHERE network_id=n.id GROUP BY json_extract(record,'$.state.status'))) AS junction_counts,
          (SELECT json_group_object(status, total) FROM (
            SELECT status, COUNT(*) AS total FROM trains
            WHERE network_id = n.id GROUP BY status)) AS train_counts,
          (SELECT COUNT(*) FROM stations
            WHERE network_id = n.id AND status <> 'cancelled') AS station_total,
          (SELECT COUNT(*) FROM stations
            WHERE network_id = n.id AND status = 'complete') AS station_complete,
          (SELECT COUNT(*) FROM cars WHERE network_id = n.id) AS car_count,
          (SELECT COUNT(*) FROM conflicts
            WHERE network_id = n.id AND status = 'open') AS open_conflicts,
          (SELECT COUNT(*) FROM dispatch_plans
            WHERE network_id = n.id AND status = 'ready') AS plans_ready,
          (SELECT MAX(occurred_at) FROM events
            WHERE network_id = n.id) AS last_event_at,
          (SELECT json_object('at', occurred_at,
              'commit', json_extract(payload, '$.mergeCommit'))
            FROM events WHERE network_id = n.id AND type = 'terminus.promoted'
            ORDER BY seq DESC LIMIT 1) AS last_promotion,
          (SELECT COUNT(*) FROM events
            WHERE network_id = n.id AND type = 'terminus.promoted') AS promotions
        FROM networks n
        ${networkId ? "WHERE n.id = ?" : ""}
        ORDER BY n.created_at DESC`
    )
    const scoped = (sql: string) =>
      networkId
        ? this.#db.prepare(`${sql} WHERE network_id = ?`).bind(networkId)
        : this.#db.prepare(sql)
    const [listings, lineRows, trainRows, junctionRows] = await this.#db.batch([
      networkId ? statement.bind(networkId) : statement,
      this.#db
        .prepare(
          `SELECT network_id, record, created_at FROM lines
            ${networkId ? "WHERE network_id = ?" : ""} ORDER BY rowid`
        )
        .bind(...(networkId ? [networkId] : [])),
      scoped(
        `SELECT network_id, line_id, status, COALESCE(state_entered_at, (
             SELECT max(occurred_at) FROM events
             WHERE events.network_id = trains.network_id AND events.train_id = trains.id
           )) AS state_entered_at FROM trains`
      ),
      scoped("SELECT network_id, record FROM junctions"),
    ])
    const byNetwork = <T extends { network_id: string }>(
      result: D1Result | undefined
    ) => {
      const groups = new Map<string, T[]>()
      for (const row of (result?.results ?? []) as T[])
        groups.set(row.network_id, [...(groups.get(row.network_id) ?? []), row])
      return groups
    }
    const lines = byNetwork<
      RecordRow & { network_id: string; created_at: string | null }
    >(lineRows)
    const trains = byNetwork<{
      network_id: string
      line_id: string
      status: TrainState["status"]
      state_entered_at: string | null
    }>(trainRows)
    const junctions = byNetwork<RecordRow & { network_id: string }>(
      junctionRows
    )
    /** The Lines the map draws with a running Train, numbered and coloured
     * as the map draws them. */
    const activeLines = (network: NetworkRow) => {
      const rows = lines.get(network.id) ?? []
      const records = rows.map((row) => {
        const line = parse<Line>(row)
        return { ...line, stops: lineStops(line) }
      })
      const views = (trains.get(network.id) ?? []).map((row) => ({
        train: { lineId: row.line_id, state: { status: row.status } },
        stateEnteredAt: row.state_entered_at ?? network.created_at,
      }))
      const identities = lineIdentities({
        network: { createdAt: network.created_at },
        lines: records,
        lineCreatedAt: Object.fromEntries(
          rows.flatMap((row, i) =>
            row.created_at ? [[records[i]!.id, row.created_at]] : []
          )
        ),
        trains: views,
        junctions: (junctions.get(network.id) ?? []).map((row) =>
          parse<Junction>(row)
        ),
      })
      return records.flatMap((line) => {
        const status = views.find(
          (view) =>
            view.train.lineId === line.id &&
            view.train.state.status !== "unloaded" &&
            view.train.state.status !== "siding"
        )?.train.state.status
        const identity = identities.get(line.id)!
        return status
          ? [
              {
                name: line.name,
                number: identity.slot + 1,
                color: identity.color,
                status,
              },
            ]
          : []
      })
    }
    return (listings!.results as NetworkListingRow[]).map((row) => ({
      ...toNetwork(row),
      activity: {
        lines: row.line_count,
        junctions: JSON.parse(
          row.junction_counts ?? "{}"
        ) as NetworkActivity["junctions"],
        trains: JSON.parse(
          row.train_counts ?? "{}"
        ) as NetworkActivity["trains"],
        activeLines: activeLines(row),
        stations: { total: row.station_total, complete: row.station_complete },
        cars: row.car_count,
        openConflicts: row.open_conflicts,
        plansAwaitingLaunch: row.plans_ready,
        lastEventAt: row.last_event_at,
        lastPromotion: row.last_promotion
          ? (JSON.parse(row.last_promotion) as NetworkActivity["lastPromotion"])
          : null,
        promotions: row.promotions,
      },
    }))
  }

  async line(id: LineId): Promise<Line | null> {
    const row = await this.#db
      .prepare("SELECT record FROM lines WHERE id = ?")
      .bind(id)
      .first<RecordRow>()
    if (!row) return null
    const line = parse<Line>(row)
    return { ...line, stops: lineStops(line) }
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
    // No deletion pre-check: the network_deleting triggers fence every table
    // written here, atomically inside the batch.
    const occurredAt = new Date().toISOString()
    const created = writes.filter(
      (write) =>
        (write.kind === "train" ||
          write.kind === "dispatch_plan" ||
          write.kind === "technician_repair" ||
          write.kind === "junction") &&
        write.version === null
    )
    const configurations: D1PreparedStatement[] = []
    if (created.length) {
      const config =
        this.#creationExecutions ?? (await this.networkExecutions(networkId))
      for (const write of created) {
        const entity =
          write.kind === "train"
            ? write.train
            : write.kind === "dispatch_plan"
              ? write.plan
              : write.kind === "technician_repair"
                ? write.repair
                : write.kind === "junction"
                  ? write.junction
                  : null
        if (!entity) continue
        configurations.push(
          this.#db
            .prepare(
              "INSERT INTO execution_configs (kind, work_id, network_id, config, created_at) VALUES (?, ?, ?, ?, ?)"
            )
            .bind(
              write.kind,
              entity.id,
              networkId,
              JSON.stringify(config),
              occurredAt
            )
        )
      }
    }
    const statements = [
      ...writes.flatMap((write) =>
        write.kind === "dispatch_draft_copy"
          ? new DispatchDraftStore(this.#db).copyStatements(
              write.fromPlanId,
              write.toPlanId
            )
          : [this.#statement(networkId, write, occurredAt)]
      ),
      ...configurations,
      ...events.map((event) => this.#event(networkId, event, occurredAt)),
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
      crossings,
      junctions,
      junctionRepairs,
      junctionApprovals,
      engineerNotices,
      conflictWatches,
    ] = await this.#db.batch([
      this.#db.prepare("SELECT * FROM networks WHERE id = ?").bind(networkId),
      this.#db
        .prepare(
          "SELECT record, created_at FROM lines WHERE network_id = ? ORDER BY rowid"
        )
        .bind(networkId),
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
      select("crossings"),
      select("junctions"),
      select("junction_repairs"),
      this.#db
        .prepare(
          "SELECT junction_commands.id AS junctionId,release_commit AS releaseCommit FROM junction_commands JOIN junctions ON junctions.id=junction_commands.id WHERE junctions.network_id=? AND release_commit IS NOT NULL"
        )
        .bind(networkId),
      select("engineer_notices"),
      select("conflict_watches"),
    ])
    const network = networks!.results[0] as NetworkRow | undefined
    if (!network) return null
    const records = <T>(result: D1Result | undefined) =>
      (result?.results as RecordRow[]).map((row) => parse<T>(row))
    return {
      network: toNetwork(network),
      conflictConcerns: activeConflictConcerns(
        records<ConflictWatch>(conflictWatches).map((watch) =>
          conflictWatchSchema.parse(watch)
        ),
        (trains!.results as TrainRow[]).map((row) => parse<Train>(row))
      ),
      engineerNotices: records<EngineerNotice>(engineerNotices)
        .filter((notice) => !notice.resolvedAt && !notice.acknowledgedAt)
        .map((notice) => engineerNoticeSchema.parse(notice)),
      junctionApprovals: (
        junctionApprovals!.results as {
          junctionId: string
          releaseCommit: string
        }[]
      ).map((a) => ({ junctionId: a.junctionId, commit: a.releaseCommit })),
      junctions: records<Junction>(junctions).map((j) =>
        junctionSchema.parse(j)
      ),
      crossings: records<Crossing>(crossings),
      lines: records<Line>(lines).map((line) => ({
        ...line,
        stops: lineStops(line),
      })),
      lineCreatedAt: Object.fromEntries(
        (lines!.results as (RecordRow & { created_at: string | null })[])
          .filter((row) => row.created_at)
          .map((row) => [(JSON.parse(row.record) as Line).id, row.created_at!])
      ),
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
      repairs: [
        ...records<TechnicianRepair>(repairs),
        ...records<TechnicianRepair>(junctionRepairs),
      ].map((repair) => technicianRepairSchema.parse(repair)),
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
    write: Exclude<Write, { kind: "dispatch_draft_copy" }>,
    occurredAt: string
  ): D1PreparedStatement {
    const db = this.#db
    switch (write.kind) {
      case "junction_command_consumed":
        return db
          .prepare("DELETE FROM junction_commands WHERE id=?")
          .bind(write.junctionId)
      case "engineer_assessment":
        return db
          .prepare(
            "INSERT INTO engineer_assessments(id,network_id,train_id,record) VALUES (?,?,?,?)"
          )
          .bind(
            write.assessment.id,
            networkId,
            write.assessment.trainId,
            JSON.stringify(engineerAssessmentSchema.parse(write.assessment))
          )
      case "conflict_watch": {
        const record = JSON.stringify(conflictWatchSchema.parse(write.watch))
        return write.version === null
          ? db
              .prepare(
                "INSERT INTO conflict_watches(id,network_id,train_id,car_id,record,version) VALUES (?,?,?,?,?,0)"
              )
              .bind(
                write.watch.id,
                networkId,
                write.watch.trainId,
                write.watch.carId,
                record
              )
          : db
              .prepare(
                "UPDATE conflict_watches SET record=?,version=? WHERE id=? AND network_id=?"
              )
              .bind(record, write.version + 1, write.watch.id, networkId)
      }
      case "engineer_notice": {
        const record = JSON.stringify(engineerNoticeSchema.parse(write.notice))
        return write.version === null
          ? db
              .prepare(
                "INSERT INTO engineer_notices(id,network_id,train_id,record,version) VALUES (?,?,?,?,0)"
              )
              .bind(write.notice.id, networkId, write.notice.trainId, record)
          : db
              .prepare(
                "UPDATE engineer_notices SET record=?,version=? WHERE id=? AND network_id=?"
              )
              .bind(record, write.version + 1, write.notice.id, networkId)
      }
      case "junction_ack":
        return db
          .prepare(
            "UPDATE integration_attempts SET status='completed' WHERE id=? AND purpose='junction' AND status='prepared' AND json_extract(result,'$.ok')=1"
          )
          .bind(write.integrationId)
      case "junction": {
        if (write.junction.networkId !== networkId)
          throw new Error("Junction belongs to another network")
        const record = JSON.stringify(junctionSchema.parse(write.junction))
        return write.version === null
          ? db
              .prepare(
                "INSERT INTO junctions(id,network_id,record,version) VALUES (?,?,?,0)"
              )
              .bind(write.junction.id, networkId, record)
          : db
              .prepare("UPDATE junctions SET record=?,version=? WHERE id=?")
              .bind(record, write.version + 1, write.junction.id)
      }
      case "siding_consumed":
        return db
          .prepare("DELETE FROM train_siding_requests WHERE id=?")
          .bind(write.trainId)
      case "crossing": {
        const { crossing: c, version } = write
        const record = JSON.stringify(crossingSchema.parse(c))
        return version === null
          ? db
              .prepare(
                "INSERT INTO crossings(id,network_id,line_id,source_station_id,record,version) VALUES (?,?,?,?,?,0)"
              )
              .bind(c.id, networkId, c.lineId, c.sourceStationId, record)
          : db
              .prepare("UPDATE crossings SET record=?,version=? WHERE id=?")
              .bind(record, version + 1, c.id)
      }
      case "checkpoint":
        return db
          .prepare(
            "INSERT INTO station_checkpoints(id,network_id,record) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING"
          )
          .bind(
            write.checkpoint.stationId,
            networkId,
            JSON.stringify(checkpointSchema.parse(write.checkpoint))
          )
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
        if (repair.source.junctionId)
          return version === null
            ? db
                .prepare(
                  "INSERT INTO junction_repairs(id,network_id,record,version) VALUES (?,?,?,0)"
                )
                .bind(repair.id, networkId, record)
            : db
                .prepare(
                  "UPDATE junction_repairs SET record=?,version=? WHERE id=?"
                )
                .bind(record, version + 1, repair.id)
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
            "INSERT INTO networks (id, name, terminus_repo_id, terminus_commit, created_at, validation, source_url, project_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            network.id,
            network.name,
            network.terminusRepoId,
            network.terminusCommit,
            network.createdAt,
            JSON.stringify(network.validation ?? defaultValidation),
            network.sourceUrl ?? null,
            write.projectSource ?? null
          )
      }
      case "publication": {
        const { publication } = write
        return db
          .prepare(
            "UPDATE networks SET publish_repo_id = ?, published_commit = ?, published_at = ? WHERE id = ?"
          )
          .bind(
            publication.repoId,
            publication.commit,
            publication.publishedAt,
            networkId
          )
      }
      case "line":
        return db
          .prepare(
            "INSERT INTO lines (id, network_id, record, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record"
          )
          .bind(
            write.line.id,
            networkId,
            JSON.stringify(write.line),
            occurredAt
          )
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
    ...(row.deleting ? { deleting: true } : {}),
    validation: validationCommandsSchema.parse(JSON.parse(row.validation)),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.publish_repo_id && row.published_commit && row.published_at
      ? {
          publication: {
            repoId: row.publish_repo_id,
            commit: row.published_commit,
            publishedAt: row.published_at,
            ...(row.site_url ? { siteUrl: row.site_url } : {}),
          },
        }
      : {}),
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
  review?: string | null
  diff?: string | null
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
    ...(row.review ? { review: JSON.parse(row.review) } : {}),
    ...(row.diff !== null && row.diff !== undefined ? { diff: row.diff } : {}),
  })
}

function executionInput(
  input: ReviewInput | StationRunInput,
  execution: string | AgentConfig
): string {
  return JSON.stringify(
    typeof execution === "string"
      ? { ...input, model: execution }
      : { ...input, model: execution.model, execution }
  )
}
function sameExecutionInput(
  saved: string,
  input: ReviewInput | StationRunInput,
  execution: string | AgentConfig
): boolean {
  if (saved === executionInput(input, execution)) return true
  // Model-only identities predate reasoning levels, so they never match one.
  if (typeof execution === "string") {
    const stored = JSON.parse(saved) as { execution?: AgentConfig }
    return (
      stored.execution?.harness === "opencode@1.18.32" &&
      stored.execution.model === execution &&
      !stored.execution.reasoning &&
      saved === executionInput(input, stored.execution)
    )
  }
  return (
    execution.harness === "opencode@1.18.32" &&
    !execution.reasoning &&
    saved === executionInput(input, execution.model)
  )
}
