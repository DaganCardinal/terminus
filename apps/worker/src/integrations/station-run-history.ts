import type { EventEnvelope } from "@terminus/protocol"

export interface StationRunReference {
  stationId: string
  trainId: string
  runId: string
}

/** Reconstructs execution identities from the authoritative event history.
 * Counters are lifetime counters; an explicit reset does not erase them. */
export function stationRunHistory(
  events: EventEnvelope[]
): StationRunReference[] {
  const counters = new Map<
    string,
    { signals: number; revisions: number; retries: number }
  >()
  const runs = new Map<string, StationRunReference>()
  for (const { event } of events) {
    if (
      event.type !== "station.signaled" &&
      event.type !== "station.returned" &&
      event.type !== "station.run_retried"
    )
      continue
    const counts = counters.get(event.stationId) ?? {
      signals: 0,
      revisions: 0,
      retries: 0,
    }
    if (event.type === "station.signaled") counts.signals++
    if (event.type === "station.returned") counts.revisions++
    if (event.type === "station.run_retried") counts.retries++
    counters.set(event.stationId, counts)
    const runId = `${event.stationId}-s${counts.signals}-r${counts.revisions}${counts.retries ? `-f${counts.retries}` : ""}`
    runs.set(runId, {
      stationId: event.stationId,
      trainId: event.trainId,
      runId,
    })
  }
  return [...runs.values()]
}
