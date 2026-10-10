import { expect, it } from "vitest"
import type { DomainEvent, EventEnvelope } from "@terminus/protocol"
import { stationRunHistory } from "./station-run-history"

it("finds earlier attempts, revisions and retries across resets without inventing combinations", () => {
  const events: DomainEvent[] = [
    { type: "station.signaled", stationId: "s", trainId: "t" },
    {
      type: "station.run_retried",
      stationId: "s",
      trainId: "t",
      issues: [],
      backoff: false,
    },
    {
      type: "station.returned",
      stationId: "s",
      trainId: "t",
      feedback: { summary: "Fix", findings: [] },
    },
    { type: "station.reset", stationId: "s" },
    { type: "station.signaled", stationId: "s", trainId: "t" },
    { type: "station.signaled", stationId: "other", trainId: "other-train" },
  ]
  const envelopes = events.map((event, index) => ({
    seq: index + 1,
    networkId: "n",
    occurredAt: "2026-10-10T00:00:00.000Z",
    event,
  })) as EventEnvelope[]
  expect(stationRunHistory(envelopes).map((run) => run.runId)).toEqual([
    "s-s1-r0",
    "s-s1-r0-f1",
    "s-s1-r1-f1",
    "s-s2-r1-f1",
    "other-s1-r0",
  ])
})
