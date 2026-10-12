import {
  DEFAULT_SANDBOX_LIMITS,
  sandboxLimitsSchema,
  type SandboxKind,
  type SandboxLimits,
} from "@terminus/protocol"
import type { SandboxBinding } from "./execution-sandbox"

/** The limit a Sandbox counts against, by the binding that holds it. */
export const sandboxKind: Record<SandboxBinding, SandboxKind> = {
  SANDBOX: "agent",
  WORKSPACE_SANDBOX: "agentless",
}

/** Thrown when a network has no free Sandbox of a kind. Matched by message
 * across RPC, which keeps only an Error's message. */
export const SANDBOX_CAPACITY_MESSAGE = "Sandbox capacity reached"

export interface SandboxLease {
  objectId: string
  /** The owning network's Artifacts namespace; empty before one is known. */
  namespace: string
  binding: SandboxBinding
}

/**
 * The network's Sandbox limits and sizes: its override, else General, else
 * the defaults. A namespace still being onboarded has no network yet, so it
 * follows General.
 */
export async function sandboxLimits(
  db: D1Database,
  namespace: string
): Promise<SandboxLimits> {
  const { results } = await db
    .prepare(
      "SELECT scope, limits FROM sandbox_limits WHERE scope = 'general' OR scope IN (SELECT 'network:' || id FROM networks WHERE terminus_repo_id = ?)"
    )
    .bind(`${namespace}/terminus`)
    .all<{ scope: string; limits: string }>()
  const parsed = (scope: (value: string) => boolean) => {
    const row = results.find((candidate) => scope(candidate.scope))
    return row ? sandboxLimitsSchema.parse(JSON.parse(row.limits)) : null
  }
  return (
    parsed((scope) => scope !== "general") ??
    parsed((scope) => scope === "general") ??
    DEFAULT_SANDBOX_LIMITS
  )
}

/** The network's limit for this kind of Sandbox. */
export async function sandboxLimit(
  db: D1Database,
  lease: Pick<SandboxLease, "namespace" | "binding">
): Promise<number> {
  return (await sandboxLimits(db, lease.namespace))[sandboxKind[lease.binding]]
}

/**
 * Takes a slot for a container about to start, or returns false when the
 * network already runs `limit` live Sandboxes of this kind. One conditional
 * insert decides, so concurrent starts cannot both take the last slot.
 */
export async function acquireSandboxLease(
  db: D1Database,
  lease: SandboxLease,
  limit: number,
  now: number,
  ttlMs: number
): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM sandbox_leases WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO sandbox_leases (object_id, namespace, binding, expires_at) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM sandbox_leases WHERE namespace = ?2 AND binding = ?3 AND object_id <> ?1) < ?5 ON CONFLICT(object_id) DO UPDATE SET namespace = excluded.namespace, binding = excluded.binding, expires_at = excluded.expires_at"
      )
      .bind(lease.objectId, lease.namespace, lease.binding, now + ttlMs, limit),
  ])
  return (inserted?.meta.changes ?? 0) > 0
}

/** Extends a running container's lease. It never refuses: the container is
 * already running, and a lowered limit applies only to new starts. */
export async function renewSandboxLease(
  db: D1Database,
  lease: SandboxLease,
  now: number,
  ttlMs: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sandbox_leases (object_id, namespace, binding, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(object_id) DO UPDATE SET expires_at = excluded.expires_at"
    )
    .bind(lease.objectId, lease.namespace, lease.binding, now + ttlMs)
    .run()
}

export async function releaseSandboxLease(
  db: D1Database,
  objectId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM sandbox_leases WHERE object_id = ?")
    .bind(objectId)
    .run()
}
