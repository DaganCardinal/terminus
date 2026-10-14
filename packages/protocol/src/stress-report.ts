import { z } from "zod"

export interface TimingEvent {
  occurredAt: string
  event: { type: string; trainId?: string; integrationId?: string }
}
export interface ApiSample {
  ms: number
  ok: boolean
}
interface TrainTiming {
  trainId: string
  departedAt?: number
  requestedAt?: number
  grantedAt?: number
  promotedAt?: number
}
interface PhaseSnapshot {
  stations: { id: string }[]
  trains: { train: { id: string } }[]
  cars: { acceptedCommit: string }[]
}
const phaseSchema = z.object({
  stationId: z.string().optional(),
  trainId: z.string().optional(),
  integrationId: z.string().optional(),
  candidate: z.string().optional(),
  runId: z.string().optional(),
  sandbox: z.string().optional(),
  ok: z.boolean().optional(),
  ms: z.number().optional(),
  waitedMs: z.number().optional(),
  phases: z.record(z.string(), z.number()).optional(),
})
/** Durations come from durable event timestamps; polling cadence cannot inflate them. */
export function stressTimings(events: TimingEvent[]) {
  const queue = new Map<string, number>()
  const active = new Map<string, number>()
  const trains = new Map<string, TrainTiming>()
  const findings: string[] = []
  let maxQueueDepth = 0
  for (const envelope of events) {
    const { event } = envelope
    const time = Date.parse(envelope.occurredAt)
    const id = event.trainId
    if (!id) continue
    const train = trains.get(id) ?? { trainId: id }
    trains.set(id, train)
    if (event.type === "train.departed") train.departedAt ??= time
    if (event.type === "terminus.integration_requested") {
      queue.set(id, time)
      train.requestedAt = time
    }
    if (event.type === "terminus.clearance_granted") {
      if (active.size)
        findings.push(
          "Overlapping canonical integration reservations in the event log"
        )
      active.set(id, time)
      queue.delete(id)
      train.grantedAt = time
    }
    if (event.type === "terminus.promoted") {
      if (!active.has(id))
        findings.push(`Promotion without a recorded reservation: ${id}`)
      train.promotedAt = time
      active.delete(id)
    }
    if (
      event.type === "terminus.integration_failed" ||
      event.type === "terminus.integration_deferred" ||
      event.type === "terminus.integration_interrupted"
    )
      active.delete(id)
    maxQueueDepth = Math.max(maxQueueDepth, queue.size)
  }
  const rows = [...trains.values()].map((train) => ({
    ...train,
    workMs:
      train.requestedAt !== undefined && train.departedAt !== undefined
        ? train.requestedAt - train.departedAt
        : null,
    queueMs:
      train.grantedAt !== undefined && train.requestedAt !== undefined
        ? train.grantedAt - train.requestedAt
        : null,
    integrationMs:
      train.promotedAt !== undefined && train.grantedAt !== undefined
        ? train.promotedAt - train.grantedAt
        : null,
  }))
  const promotions = rows
    .filter((train) => train.promotedAt !== undefined)
    .map((train) => train.promotedAt!)
  const firstRequest = Math.min(
    ...rows.map((train) => train.requestedAt ?? Infinity)
  )
  const drainMs =
    promotions.length && Number.isFinite(firstRequest)
      ? Math.max(...promotions) - firstRequest
      : null
  return {
    maxQueueDepth,
    drainMs,
    integrationsPerMinute:
      drainMs !== null && drainMs > 0
        ? (promotions.length * 60_000) / drainMs
        : null,
    trains: rows,
    findings,
  }
}

export interface InterventionEvent {
  event: { type: string; trainId?: string; issues?: { detail: string }[] }
}
const interventions = new Map<string, "failed" | "blocked" | "cleared">([
  ["station.run_failed", "failed"],
  ["train.blocked", "blocked"],
  ["train.cleared", "cleared"],
])

/**
 * Failed Station runs, blocks and clearances in the durable event log, one
 * finding per Train in order of first occurrence. Clearing a blocked Train
 * resets its Station's retry counters, so a Train that was unblocked and then
 * unloaded shows its intervention only here.
 */
export function stressInterventions(
  events: InterventionEvent[],
  label: (trainId: string) => string
): string[] {
  const trains = new Map<
    string,
    { failed: number; blocked: number; cleared: number; details: Set<string> }
  >()
  for (const { event } of events) {
    const kind = interventions.get(event.type)
    if (!kind || !event.trainId) continue
    const train = trains.get(event.trainId) ?? {
      failed: 0,
      blocked: 0,
      cleared: 0,
      details: new Set<string>(),
    }
    trains.set(event.trainId, train)
    train[kind]++
    for (const issue of event.issues ?? []) train.details.add(issue.detail)
  }
  const times = (count: number) => (count > 1 ? ` ${count} times` : "")
  return [...trains].map(([trainId, train]) => {
    const what = [
      ...(train.failed
        ? [
            train.failed > 1
              ? `${train.failed} Station runs failed`
              : "Station run failed",
          ]
        : []),
      ...(train.blocked ? [`blocked${times(train.blocked)}`] : []),
      ...(train.cleared
        ? [`cleared by intervention${times(train.cleared)}`]
        : []),
    ]
    const details = [...train.details].join("; ").slice(0, 300)
    const listed =
      what.length > 1
        ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}`
        : what[0]
    return `${label(trainId)}: ${listed}${details ? ` (${details})` : ""}`
  })
}

const placementRetrySchema = z.object({
  sandbox: z.string(),
  binding: z.string(),
  pauseMs: z.number(),
})

/**
 * TEMPORARY, with the perf logs it reads: one warning per Sandbox whose
 * container Cloudflare could not place, in order of its first retry. Sandbox
 * start retries these below the Station run and records no event, so
 * otherwise a run that spent minutes on them only looks slow.
 */
export function stressPlacementRetries(
  records: { message: string }[],
  inRun: (sandbox: string, binding: string) => boolean,
  label: (sandbox: string) => string
): string[] {
  const sandboxes = new Map<string, { retries: number; pausedMs: number }>()
  for (const record of records) {
    const match = /^\[perf\] sandbox\.placement_retry (\{.*\})$/.exec(
      record.message
    )
    if (!match) continue
    let fields: z.infer<typeof placementRetrySchema>
    try {
      fields = placementRetrySchema.parse(JSON.parse(match[1]!))
    } catch {
      continue
    }
    if (!inRun(fields.sandbox, fields.binding)) continue
    const sandbox = sandboxes.get(fields.sandbox) ?? { retries: 0, pausedMs: 0 }
    sandboxes.set(fields.sandbox, sandbox)
    sandbox.retries++
    sandbox.pausedMs += fields.pauseMs
  }
  return [...sandboxes].map(
    ([name, { retries, pausedMs }]) =>
      `${label(name)}: Cloudflare could not place its container ${retries === 1 ? "once" : `${retries} times`} and retried after ${Math.round(pausedMs / 1000)} s of pauses`
  )
}

export function latencySummary(samples: ApiSample[]) {
  if (!samples.length) return null
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b)
  const percentile = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return {
    requests: sorted.length,
    errors: samples.filter((sample) => !sample.ok).length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
  }
}

/** Scope spans by durable identities; the raw Perf Tail window may contain other work. */
export function phaseTimings(
  records: { message: string }[] | undefined,
  snapshot: PhaseSnapshot | undefined,
  events: TimingEvent[] = []
) {
  const stations = new Set(
    snapshot?.stations.map((station) => station.id) ?? []
  )
  const trains = new Set(snapshot?.trains.map(({ train }) => train.id) ?? [])
  const candidates = new Set(
    snapshot?.cars.map((car) => car.acceptedCommit.slice(0, 12)) ?? []
  )
  const integrations = new Set(
    events.flatMap(({ event }) =>
      event.integrationId ? [event.integrationId] : []
    )
  )
  const groups = new Map<string, ApiSample[]>()
  for (const record of records ?? []) {
    const match = /^\[perf\] (\S+) (\{.*\})$/.exec(record.message)
    if (!match) continue
    let fields: z.infer<typeof phaseSchema>
    try {
      fields = phaseSchema.parse(JSON.parse(match[2]!))
    } catch {
      continue
    }
    if (
      !stations.has(fields.stationId ?? "") &&
      !trains.has(fields.trainId ?? "") &&
      !candidates.has(fields.candidate ?? "") &&
      !integrations.has(fields.integrationId ?? "") &&
      ![...stations].some(
        (id) =>
          fields.runId?.startsWith(`${id}-`) ||
          fields.sandbox?.startsWith(`station-${id}-`)
      )
    )
      continue
    const add = (name: string, ms: number | undefined) => {
      if (ms === undefined || !Number.isFinite(ms)) return
      const group = groups.get(name) ?? []
      group.push({ ms, ok: fields.ok !== false })
      groups.set(name, group)
    }
    if (fields.phases)
      for (const [phase, ms] of Object.entries(fields.phases))
        add(`${match[1]}:${phase}`, ms)
    else if (match[1] === "sandbox.lease")
      add("sandbox.capacity_wait", fields.waitedMs)
    else if (!match[1].endsWith(".phase")) add(match[1], fields.ms)
  }
  return Object.fromEntries(
    [...groups].map(([name, samples]) => [
      name,
      {
        ...latencySummary(samples),
        totalMs: samples.reduce((sum, sample) => sum + sample.ms, 0),
      },
    ])
  )
}
