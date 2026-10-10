import { parseRepoId } from "@terminus/artifacts"
import { NetworkStore } from "./network-store"
import { stationRunHistory } from "./station-run-history"

export class NetworkDeletionStore {
  private readonly db: D1Database
  constructor(db: D1Database) {
    this.db = db
  }

  async begin(networkId: string) {
    const store = new NetworkStore(this.db)
    const network = await store.network(networkId)
    if (!network) return null
    await this.db
      .prepare("UPDATE networks SET deleting = 1 WHERE id = ?")
      .bind(networkId)
      .run()
    return { network, namespace: parseRepoId(network.terminusRepoId).namespace }
  }

  async inventory(networkId: string, namespace: string) {
    const tables = [
      "trains",
      "dispatch_plans",
      "technician_repairs",
      "junction_repairs",
      "junctions",
      "integration_attempts",
      "agent_runs",
    ] as const
    const rows = await Promise.all(
      tables.map(async (table) => {
        const { results } = await this.db
          .prepare(`SELECT id FROM ${table} WHERE network_id = ?`)
          .bind(networkId)
          .all<{ id: string }>()
        return results.map((row) => row.id)
      })
    )
    const store = new NetworkStore(this.db)
    const events = []
    let after = 0
    for (;;) {
      const page = await store.eventsAfter(networkId, after)
      events.push(...page)
      if (page.length < 500) break
      after = page.at(-1)!.seq
    }
    const runIds = [
      ...new Set([
        ...rows[6]!,
        ...stationRunHistory(events).map((run) => run.runId),
      ]),
    ]
    const { results: sandboxes } = await this.db
      .prepare("SELECT object_id FROM network_sandboxes WHERE namespace = ?")
      .bind(namespace)
      .all<{ object_id: string }>()
    return {
      workflows: {
        TRAIN_WORKFLOW: rows[0]!,
        DISPATCH_WORKFLOW: rows[1]!,
        TECHNICIAN_WORKFLOW: [...new Set([...rows[2]!, ...rows[3]!])],
        JUNCTION_WORKFLOW: rows[4]!,
        INTEGRATION_WORKFLOW: rows[5]!,
        STATION_WORKFLOW: runIds,
      },
      sandboxIds: sandboxes.map((row) => row.object_id),
      runIds,
      events,
      trains: (await store.trains(networkId)).map((row) => row.value),
    }
  }

  async erase(networkId: string, namespace: string): Promise<void> {
    // Children first; D1 foreign keys remain enabled and the entire erase is atomic.
    const statements = [
      this.db
        .prepare(
          "DELETE FROM junction_entries WHERE junction_id IN (SELECT id FROM junctions WHERE network_id = ?) OR train_id IN (SELECT id FROM trains WHERE network_id = ?)"
        )
        .bind(networkId, networkId),
      this.db
        .prepare(
          "DELETE FROM junction_commands WHERE id IN (SELECT id FROM junctions WHERE network_id = ?)"
        )
        .bind(networkId),
      this.db
        .prepare(
          "DELETE FROM train_siding_requests WHERE id IN (SELECT id FROM trains WHERE network_id = ?)"
        )
        .bind(networkId),
      ...[
        "execution_configs",
        "model_settings",
        "junction_repairs",
        "technician_repairs",
        "integration_attempts",
        "dispatch_plans",
        "agent_runs",
        "conductor_reviews",
        "station_checkpoints",
        "crossings",
        "train_unload_policies",
        "cars",
        "holds",
        "conflicts",
        "events",
        "junctions",
        "trains",
        "stations",
        "lines",
      ].map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE network_id = ?`)
          .bind(networkId)
      ),
      this.db
        .prepare("DELETE FROM network_sandboxes WHERE namespace = ?")
        .bind(namespace),
      this.db
        .prepare("DELETE FROM repository_provisions WHERE namespace = ?")
        .bind(namespace),
      this.db.prepare("DELETE FROM networks WHERE id = ?").bind(networkId),
    ]
    await this.db.batch(statements)
  }
}
