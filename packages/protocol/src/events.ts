import { z } from "zod"
import { unloadModeSchema } from "./unload"

export const issueSchema = z.object({
  kind: z.enum([
    "required_checks_failed",
    "conflict",
    "dependency_unresolvable",
    "station_failed",
    "station_change_required",
    "station_retries_exhausted",
    "review_escalated",
    "integration_failed",
    "needs_user",
  ]),
  detail: z.string(),
})

export const holdReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("awaiting_user_approval"),
    trainCommit: z.string(),
  }),
  z.object({ kind: z.literal("user_hold"), holdId: z.string() }),
  z.object({ kind: z.literal("sequencing"), holdId: z.string() }),
  z.object({ kind: z.literal("dependency"), stationId: z.string() }),
])

export const holdSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "sequencing"]),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("network") }),
    z.object({ kind: z.literal("line"), lineId: z.string() }),
    z.object({ kind: z.literal("train"), trainId: z.string() }),
  ]),
  note: z.string(),
})

export const reviewFeedbackSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
})

const trainEvent = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), trainId: z.string() })

const trainAtStationEvent = <T extends string>(type: T) =>
  trainEvent(type).extend({ stationId: z.string() })

const stationEvent = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), stationId: z.string() })

const issues = z.array(issueSchema).min(1)

export const domainEventSchema = z.discriminatedUnion("type", [
  trainAtStationEvent("crossing.created").extend({ crossingId: z.string() }),
  trainAtStationEvent("crossing.approaching").extend({
    crossingId: z.string(),
  }),
  trainAtStationEvent("crossing.started").extend({ crossingId: z.string() }),
  trainAtStationEvent("crossing.blocked").extend({ crossingId: z.string() }),
  trainAtStationEvent("crossing.retried").extend({ crossingId: z.string() }),
  trainAtStationEvent("crossing.completed").extend({
    crossingId: z.string(),
    mergeCommit: z.string(),
    carIds: z.array(z.string()),
  }),
  trainEvent("train.unload_mode_changed").extend({ mode: unloadModeSchema }),
  trainEvent("train.unload_approved").extend({
    trainCommit: z.string(),
    approvedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("dispatcher.unload_mode_changed"),
    planId: z.string(),
    lineKey: z.string(),
    mode: unloadModeSchema,
  }),
  trainEvent("technician.integration_failed").extend({ repairId: z.string() }),
  trainEvent("technician.validated").extend({ repairId: z.string() }),
  trainEvent("technician.dispatched").extend({ repairId: z.string() }),
  trainEvent("technician.started").extend({ repairId: z.string() }),
  trainEvent("technician.candidate_prepared").extend({ repairId: z.string() }),
  trainEvent("technician.reviewed").extend({ repairId: z.string() }),
  trainEvent("technician.approved").extend({ repairId: z.string() }),
  trainEvent("technician.failed").extend({ repairId: z.string() }),
  trainEvent("technician.integrated").extend({ repairId: z.string() }),
  trainEvent("technician.stale").extend({ repairId: z.string() }),

  trainAtStationEvent("dispatcher.user_attention_requested").extend({ issues }),
  z.object({
    type: z.literal("dispatcher.plan_requested"),
    planId: z.string(),
  }),
  z.object({ type: z.literal("dispatcher.plan_ready"), planId: z.string() }),
  z.object({
    type: z.literal("dispatcher.launch_requested"),
    planId: z.string(),
  }),
  z.object({ type: z.literal("dispatcher.plan_failed"), planId: z.string() }),
  z.object({
    type: z.literal("dispatcher.lines_laid"),
    planId: z.string(),
    lineIds: z.array(z.string()),
    trainIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("dispatcher.plan_launched"),
    planId: z.string(),
    lineIds: z.array(z.string()),
    trainIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("line.created"),
    lineId: z.string(),
    stationIds: z.array(z.string()),
  }),
  trainEvent("train.created").extend({
    lineId: z.string(),
    repoId: z.string(),
    terminusBaseline: z.string(),
  }),
  trainAtStationEvent("train.departed"),
  trainAtStationEvent("train.approaching"),
  trainAtStationEvent("train.arrived"),
  trainEvent("train.held").extend({
    reasons: z.array(holdReasonSchema).min(1),
  }),
  trainEvent("train.released"),
  trainEvent("train.blocked").extend({ issues }),
  trainEvent("train.issue_raised").extend({ issues }),
  trainEvent("train.cleared"),
  trainEvent("train.returning"),
  trainEvent("train.unloaded"),
  trainEvent("train.sided").extend({ reason: z.string() }),
  stationEvent("station.signaled").extend({ trainId: z.string() }),
  stationEvent("station.workspace_created").extend({
    repoId: z.string(),
    baseCommit: z.string(),
  }),
  stationEvent("station.started"),
  stationEvent("station.ready_for_pickup").extend({ headCommit: z.string() }),
  stationEvent("station.returned").extend({
    trainId: z.string(),
    feedback: reviewFeedbackSchema,
  }),
  stationEvent("station.blocked").extend({ issues }),
  stationEvent("station.reset"),
  stationEvent("station.cancelled").extend({ reason: z.string() }),
  stationEvent("station.removal_requested").extend({ reason: z.string() }),
  stationEvent("station.removal_refused").extend({ reason: z.string() }),
  trainAtStationEvent("review.started"),
  trainAtStationEvent("car.attached").extend({
    carId: z.string(),
    acceptedCommit: z.string(),
  }),
  z.object({
    type: z.literal("conflict.detected"),
    conflictId: z.string(),
    trainIds: z.array(z.string()).min(1),
    paths: z.array(z.string()),
  }),
  z.object({ type: z.literal("conflict.resolved"), conflictId: z.string() }),
  z.object({ type: z.literal("hold.placed"), hold: holdSchema }),
  z.object({ type: z.literal("hold.released"), holdId: z.string() }),
  trainEvent("terminus.integration_requested"),
  trainEvent("terminus.integration_started"),
  trainEvent("terminus.integration_deferred"),
  trainEvent("terminus.integration_interrupted").extend({
    integrationId: z.string(),
    issues,
  }),
  trainEvent("terminus.integration_retried").extend({
    integrationId: z.string(),
  }),
  trainEvent("terminus.clearance_granted").extend({
    integrationId: z.string(),
  }),
  trainEvent("terminus.candidate_prepared").extend({
    integrationId: z.string(),
    mergeCommit: z.string(),
  }),
  trainEvent("terminus.promoted").extend({
    integrationId: z.string(),
    mergeCommit: z.string(),
  }),
  trainEvent("terminus.integration_failed").extend({
    integrationId: z.string(),
    issues,
  }),
  trainEvent("terminus.integration_completed").extend({
    mergeCommit: z.string(),
  }),
])
