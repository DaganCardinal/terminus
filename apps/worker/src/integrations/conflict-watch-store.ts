import { acknowledgeConflictPair } from "@terminus/domain"
import type { Car, ConflictWatch, DomainEvent } from "@terminus/domain"
import { conflictWatchSchema } from "@terminus/protocol"
import type { Loaded, Write } from "./network-store"

type Commit = (
  networkId: string,
  writes: Write[],
  events: DomainEvent[]
) => Promise<void>

/** The Dispatcher's conflict watches: advisory records, separate from Train state. */
export class ConflictWatchStore {
  private readonly db: D1Database
  private readonly commit: Commit
  constructor(db: D1Database, commit: Commit) {
    this.db = db
    this.commit = commit
  }

  /** The Train's Cars that no watch has looked at yet, in order. */
  async unwatchedCars(trainId: string): Promise<Car[]> {
    const { results } = await this.db
      .prepare(
        "SELECT record FROM cars c WHERE train_id=? AND NOT EXISTS (SELECT 1 FROM conflict_watches w WHERE w.car_id=c.id)"
      )
      .bind(trainId)
      .all<{ record: string }>()
    return results
      .map((row) => JSON.parse(row.record) as Car)
      .sort((a, b) => a.position - b.position)
  }

  async networkCars(networkId: string): Promise<Car[]> {
    const { results } = await this.db
      .prepare("SELECT record FROM cars WHERE network_id=?")
      .bind(networkId)
      .all<{ record: string }>()
    return results.map((row) => JSON.parse(row.record) as Car)
  }

  async car(id: string): Promise<Car | null> {
    const row = await this.db
      .prepare("SELECT record FROM cars WHERE id=?")
      .bind(id)
      .first<{ record: string }>()
    return row ? (JSON.parse(row.record) as Car) : null
  }

  async watch(id: string): Promise<Loaded<ConflictWatch> | null> {
    const row = await this.db
      .prepare(
        "SELECT record,version,network_id FROM conflict_watches WHERE id=?"
      )
      .bind(id)
      .first<{ record: string; version: number; network_id: string }>()
    return row
      ? {
          value: conflictWatchSchema.parse(JSON.parse(row.record)),
          version: row.version,
          networkId: row.network_id,
        }
      : null
  }

  async watches(networkId: string, trainId?: string): Promise<ConflictWatch[]> {
    const { results } = await this.db
      .prepare(
        `SELECT record FROM conflict_watches WHERE network_id=?${trainId ? " AND train_id=?" : ""}`
      )
      .bind(networkId, ...(trainId ? [trainId] : []))
      .all<{ record: string }>()
    return results.map((row) =>
      conflictWatchSchema.parse(JSON.parse(row.record))
    )
  }

  async save(
    networkId: string,
    watch: ConflictWatch,
    version: number | null,
    events: DomainEvent[]
  ): Promise<void> {
    await this.commit(
      networkId,
      [{ kind: "conflict_watch", watch, version }],
      events
    )
  }

  async acknowledge(
    networkId: string,
    watchId: string,
    otherTrainId: string,
    at: string
  ): Promise<ConflictWatch | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.watch(watchId)
      if (!loaded || loaded.networkId !== networkId) return null
      const change = acknowledgeConflictPair(loaded.value, otherTrainId, at)
      if (!change.events.length) return change.watch
      try {
        await this.save(networkId, change.watch, loaded.version, change.events)
        return change.watch
      } catch (error) {
        if (!String(error).includes("row changed")) throw error
      }
    }
    throw new Error("Conflict report changed while acknowledging; retry")
  }
}
