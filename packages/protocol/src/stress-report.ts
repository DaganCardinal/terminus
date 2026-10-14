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
