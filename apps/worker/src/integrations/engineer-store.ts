import { acknowledgeEngineerNotice } from "@terminus/domain"
import { boundEngineerContext } from "@terminus/agent-runtime"
import type {
  DomainEvent,
  EngineerNotice,
  Train,
  Station,
  Hold,
} from "@terminus/domain"
import {
  domainEventSchema,
  engineerAssessmentSchema,
  engineerNoticeSchema,
  engineerContextSchema,
  stationRunResultSchema,
  stationVerdictSchema,
  type EngineerAssessment,
  type EngineerContext,
  type EngineerHistoryEntry,
  type EventEnvelope,
} from "@terminus/protocol"
import type { Loaded, Write } from "./network-store"

export interface EngineerNetwork {
  network: { id: string; createdAt: string }
  trains: { train: Train }[]
  stations: (Pick<
    Station,
    "id" | "lineId" | "name" | "retryCount" | "revisionCount" | "runRetries"
  > & { state: { status: Station["state"]["status"] } })[]
  holds: Hold[]
}

type Commit = (
  networkId: string,
  writes: Write[],
  events: DomainEvent[]
) => Promise<void>
const progressTypes = [
  "station.signaled",
  "station.started",
  "station.ready_for_pickup",
  "station.returned",
  "station.run_retried",
  "station.run_failed",
  "review.started",
  "car.attached",
  "crossing.completed",
  "train.held",
  "train.released",
  "train.cleared",
]

/** Decision checkpoints and Dispatcher notice metadata, separate from Train state. */
export class EngineerStore {
  private readonly db: D1Database
  private readonly commit: Commit
  constructor(db: D1Database, commit: Commit) {
    this.db = db
    this.commit = commit
  }

  /** One consistent operational read; no Cars, patches or source content. */
  async snapshot(networkId: string): Promise<EngineerNetwork | null> {
    const [network, trains, stations, holds] = await this.db.batch([
      this.db
        .prepare("SELECT id,created_at FROM networks WHERE id=?")
        .bind(networkId),
      this.db
        .prepare("SELECT record FROM trains WHERE network_id=?")
        .bind(networkId),
      this.db
        .prepare(
          "SELECT id,line_id,status,json_extract(record, '$.name') AS name,json_extract(record, '$.retryCount') AS retry_count,json_extract(record, '$.revisionCount') AS revision_count,json_extract(record, '$.runRetries') AS run_retries FROM stations WHERE network_id=?"
        )
        .bind(networkId),
      this.db
        .prepare("SELECT record FROM holds WHERE network_id=?")
        .bind(networkId),
    ])
    const row = network!.results[0] as
      { id: string; created_at: string } | undefined
    if (!row) return null
    const records = <T>(result: D1Result | undefined) =>
      result!.results.map(
        (row) => JSON.parse((row as { record: string }).record) as T
      )
    return {
      network: { id: row.id, createdAt: row.created_at },
      trains: records<Train>(trains).map((train) => ({ train })),
      stations: stations!.results.map((value) => {
        const row = value as {
          id: string
          line_id: string
          name: string
          status: Station["state"]["status"]
          retry_count: number | null
          revision_count: number
          run_retries: number | null
        }
        return {
          id: row.id,
          lineId: row.line_id,
          name: row.name,
          state: { status: row.status },
          revisionCount: row.revision_count,
          retryCount: row.retry_count ?? undefined,
          runRetries: row.run_retries ?? undefined,
        }
      }),
      holds: records<Hold>(holds),
    }
  }
  async assessment(id: string): Promise<EngineerAssessment | null> {
    const row = await this.db
      .prepare("SELECT record FROM engineer_assessments WHERE id=?")
      .bind(id)
      .first<{ record: string }>()
    return row ? engineerAssessmentSchema.parse(JSON.parse(row.record)) : null
  }
  async recordAssessment(
    networkId: string,
    record: EngineerAssessment
  ): Promise<EngineerAssessment> {
    const existing = await this.assessment(record.id)
    if (existing) return existing
    try {
      await this.commit(
        networkId,
        [{ kind: "engineer_assessment", assessment: record }],
        [
          {
            type: "engineer.assessed",
            trainId: record.trainId,
            assessmentId: record.id,
            purpose: record.purpose,
            action: String(record.advice.value),
          },
        ]
      )
    } catch (error) {
      const winner = await this.assessment(record.id)
      if (winner) return winner
      throw error
    }
    return record
  }
  async notices(
    networkId: string,
    trainId?: string
  ): Promise<Loaded<EngineerNotice>[]> {
    const { results } = await this.db
      .prepare(
        `SELECT record,version FROM engineer_notices WHERE network_id=?${trainId ? " AND train_id=?" : ""}`
      )
      .bind(networkId, ...(trainId ? [trainId] : []))
      .all<{ record: string; version: number }>()
    return results.map((row) => ({
      value: engineerNoticeSchema.parse(JSON.parse(row.record)),
      version: row.version,
      networkId,
    }))
  }
  async saveNotice(
    networkId: string,
    notice: EngineerNotice,
    version: number | null,
    events: DomainEvent[]
  ): Promise<void> {
    await this.commit(
      networkId,
      [{ kind: "engineer_notice", notice, version }],
      events
    )
  }
  async acknowledge(
    networkId: string,
    id: string,
    at: string
  ): Promise<EngineerNotice | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const notice = (await this.notices(networkId)).find(
        (row) => row.value.id === id
      )
      if (!notice) return null
      const change = acknowledgeEngineerNotice(notice.value, at)
      if (!change.events.length) return change.notice
      const value = change.notice
      try {
        await this.saveNotice(networkId, value, notice.version, change.events)
        return value
      } catch (error) {
        if (!String(error).includes("row changed")) throw error
      }
    }
    throw new Error("Notice changed while acknowledging; retry")
  }
  async events(networkId: string, stationId: string): Promise<EventEnvelope[]> {
    const { results } = await this.db
      .prepare(
        "SELECT seq,payload,occurred_at FROM events WHERE network_id=? AND station_id=? ORDER BY seq DESC LIMIT 32"
      )
      .bind(networkId, stationId)
      .all<{ seq: number; payload: string; occurred_at: string }>()
    return results.reverse().map((row) => ({
      seq: row.seq,
      networkId,
      occurredAt: row.occurred_at,
      event: domainEventSchema.parse(JSON.parse(row.payload)),
    }))
  }
  async latestProgress(
    networkId: string,
    stationId: string,
    trainId?: string
  ): Promise<{ seq: number; at: string; reviewId?: string } | null> {
    const marks = progressTypes.map(() => "?").join(",")
    const row = await this.db
      .prepare(
        `SELECT seq,occurred_at FROM events WHERE network_id=? AND (station_id=? OR train_id=?) AND type IN (${marks}) ORDER BY seq DESC LIMIT 1`
      )
      .bind(networkId, stationId, trainId ?? "", ...progressTypes)
      .first<{ seq: number; occurred_at: string }>()
    const review = await this.db
      .prepare(
        "SELECT id,recorded_at FROM conductor_reviews WHERE network_id=? AND station_id=? ORDER BY recorded_at DESC LIMIT 1"
      )
      .bind(networkId, stationId)
      .first<{ id: string; recorded_at: string }>()
    if (review && (!row || review.recorded_at > row.occurred_at))
      return { seq: row?.seq ?? 0, at: review.recorded_at, reviewId: review.id }
    return row ? { seq: row.seq, at: row.occurred_at } : null
  }
  async latestTrainGate(
    networkId: string,
    trainId: string
  ): Promise<{ seq: number; at: string } | null> {
    const row = await this.db
      .prepare(
        "SELECT seq,occurred_at FROM events WHERE network_id=? AND train_id=? AND type IN ('train.held','train.released','train.cleared') ORDER BY seq DESC LIMIT 1"
      )
      .bind(networkId, trainId)
      .first<{ seq: number; occurred_at: string }>()
    return row ? { seq: row.seq, at: row.occurred_at } : null
  }
  async latestPauseEnd(
    networkId: string,
    trains: { id: string; lineId: string }[]
  ): Promise<{ seq: number; at: string } | null> {
    const ids = trains.map((train) => train.id)
    const lines = trains.map((train) => train.lineId)
    const row = await this.db
      .prepare(
        `SELECT e.seq,e.occurred_at FROM events e WHERE e.network_id=? AND e.type='hold.released' AND EXISTS (
      SELECT 1 FROM events p WHERE p.network_id=e.network_id AND p.type='hold.placed'
      AND json_extract(p.payload,'$.hold.id')=json_extract(e.payload,'$.holdId')
      AND json_extract(p.payload,'$.hold.kind')='user'
      AND (json_extract(p.payload,'$.hold.scope.kind')='network' OR json_extract(p.payload,'$.hold.scope.trainId') IN (${ids.map(() => "?").join(",")}) OR json_extract(p.payload,'$.hold.scope.lineId') IN (${lines.map(() => "?").join(",")}))
      ) ORDER BY e.seq DESC LIMIT 1`
      )
      .bind(networkId, ...ids, ...lines)
      .first<{ seq: number; occurred_at: string }>()
    return row ? { seq: row.seq, at: row.occurred_at } : null
  }
  async history(
    networkId: string,
    stationId: string,
    excludeRunId?: string,
    checks?: EngineerContext["checks"]
  ): Promise<EngineerContext> {
    const reset = await this.db
      .prepare(
        "SELECT max(seq) AS seq FROM events WHERE network_id=? AND station_id=? AND type='station.reset'"
      )
      .bind(networkId, stationId)
      .first<{ seq: number | null }>()
    const { results } = await this.db
      .prepare(
        `SELECT e.seq,e.payload,e.occurred_at,
      (SELECT count(*) FROM events x WHERE x.station_id=e.station_id AND x.type='station.signaled' AND x.seq<=e.seq) AS signals,
      (SELECT count(*) FROM events x WHERE x.station_id=e.station_id AND x.type='station.returned' AND x.seq<e.seq) AS revisions,
      (SELECT count(*) FROM events x WHERE x.station_id=e.station_id AND x.type='station.run_retried' AND x.seq<e.seq) AS retries
      FROM events e WHERE e.network_id=? AND e.station_id=? AND e.type IN ('station.run_failed','station.returned','station.run_retried') ORDER BY e.seq DESC LIMIT 12`
      )
      .bind(networkId, stationId)
      .all<{
        seq: number
        payload: string
        occurred_at: string
        signals: number
        revisions: number
        retries: number
      }>()
    const history: EngineerHistoryEntry[] = []
    for (const row of results.reverse()) {
      const event = domainEventSchema.parse(JSON.parse(row.payload))
      if (
        event.type !== "station.run_failed" &&
        event.type !== "station.returned" &&
        event.type !== "station.run_retried"
      )
        continue
      const runId =
        event.type === "station.run_failed"
          ? event.runId
          : `${stationId}-s${row.signals}-r${row.revisions}${row.retries ? `-f${row.retries}` : ""}`
      if (runId === excludeRunId) continue
      const previous = history.find((entry) => entry.runId === runId)
      if (previous && event.type === "station.run_retried") {
        previous.backoff = event.backoff
        previous.action = event.backoff ? "wait" : "retry"
        continue
      }
      const entry: EngineerHistoryEntry = {
        runId,
        at: row.occurred_at,
        allowance: row.seq > (reset?.seq ?? 0) ? "current" : "historical",
      }
      if (event.type === "station.run_failed") {
        entry.issues = event.issues
        entry.phase = event.phase ?? "unknown"
      } else if (event.type === "station.run_retried") {
        entry.issues = event.issues
        entry.phase = "unknown"
        entry.backoff = event.backoff
        entry.action = event.backoff ? "wait" : "retry"
      } else {
        entry.feedback = event.feedback
        entry.action = "revise"
      }
      const run = await this.db
        .prepare("SELECT result FROM agent_runs WHERE id=? AND network_id=?")
        .bind(runId, networkId)
        .first<{ result: string }>()
      if (run) {
        const result = stationRunResultSchema.parse(JSON.parse(run.result))
        if (result.ok) entry.checks = result.proposal.evidence.checks
      }
      const review = await this.db
        .prepare(
          "SELECT result FROM conductor_reviews WHERE network_id=? AND station_id=? AND json_extract(input,'$.revisionCount')=? AND recorded_at<=? ORDER BY recorded_at DESC LIMIT 1"
        )
        .bind(networkId, stationId, row.revisions, row.occurred_at)
        .first<{ result: string }>()
      if (review) {
        const result = stationVerdictSchema.parse(JSON.parse(review.result))
        if (result.evidence) entry.checks = result.evidence.checks
      }
      const next = await this.db
        .prepare(
          "SELECT payload FROM events WHERE network_id=? AND station_id=? AND seq>? AND type IN ('station.run_retried','station.returned','station.blocked') ORDER BY seq LIMIT 1"
        )
        .bind(networkId, stationId, row.seq)
        .first<{ payload: string }>()
      if (next && event.type !== "station.run_retried") {
        const action = domainEventSchema.parse(JSON.parse(next.payload))
        if (action.type === "station.run_retried") {
          entry.backoff = action.backoff
          entry.action = action.backoff ? "wait" : "retry"
        } else if (action.type === "station.blocked") entry.action = "escalate"
        else entry.action = "revise"
      }
      history.push(entry)
    }
    return engineerContextSchema.parse(
      boundEngineerContext({ history: history.slice(-4), checks })
    )
  }
}
