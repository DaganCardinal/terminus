import type {
  Car,
  Conflict,
  Hold,
  Line,
  SignalAspect,
  Station,
  Train,
  TrainState,
  DispatchPlan,
} from "@terminus/domain"
import { z } from "zod"
import { unloadModeSchema } from "./unload"
import { domainEventSchema, holdSchema } from "./events"
import { workManifestSchema } from "./manifest"
import { validationCommandsSchema, type ValidationCommand } from "./execution"

export const createNetworkRequestSchema = z.object({
  name: z.string().trim().min(1),
  sourceUrl: z
    .url({ protocol: /^https$/ })
    .refine(
      (value) => /^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value),
      "Use a public HTTPS Git URL without credentials or query parameters"
    )
    .optional(),
  validation: validationCommandsSchema.optional(),
})

export type CreateNetworkRequest = z.infer<typeof createNetworkRequestSchema>

/**
 * A Station to lay on a new Line. Manifest dependencies may name another
 * plan's `key` in the same request, or an existing Station's id.
 */
export const stationPlanRequestSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  manifest: workManifestSchema,
})

export const layLineRequestSchema = z.object({
  unloadMode: unloadModeSchema.optional(),
  name: z.string().trim().min(1),
  stations: z.array(stationPlanRequestSchema).min(1),
})

export type LayLineRequest = z.infer<typeof layLineRequestSchema>

export const removeStationRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict()
export type RemoveStationRequest = z.infer<typeof removeStationRequestSchema>

/** A command wakeup must not implicitly clear an unrelated Train blocker. */
export const trainClearEventSchema = z
  .object({ reevaluateOnly: z.boolean().optional() })
  .strict()

export const placeHoldRequestSchema = holdSchema.omit({ id: true })

export type PlaceHoldRequest = z.infer<typeof placeHoldRequestSchema>

/** One entry in a network's ordered event log. */
export const eventEnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  networkId: z.string(),
  occurredAt: z.string(),
  event: domainEventSchema,
})

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

export const eventsResponseSchema = z.object({
  events: z.array(eventEnvelopeSchema),
  lastSeq: z.number().int().nonnegative(),
})

export type EventsResponse = z.infer<typeof eventsResponseSchema>

export interface NetworkSummary {
  id: string
  name: string
  terminusRepoId: string
  terminusCommit: string
  createdAt: string
  validation?: ValidationCommand[]
}

export interface TrainView {
  train: Train
  /** The Engineer's current gate decision, as shown on the map. */
  signal: SignalAspect | null
  /** When the Train entered its current status (ISO 8601). */
  stateEnteredAt: string
  /** The state the Train left to enter its current status, and when it had
   * entered that one. Null for Trains recorded before this was tracked. */
  previous: { state: TrainState; enteredAt: string } | null
}

/** Everything needed to draw a network, as of event `lastSeq`. */
export interface NetworkSnapshot {
  network: NetworkSummary
  lines: Line[]
  stations: Station[]
  trains: TrainView[]
  cars: Car[]
  holds: Hold[]
  conflicts: Conflict[]
  repairs?: import("@terminus/domain").TechnicianRepair[]
  unloadPolicies?: import("@terminus/domain").TrainUnloadPolicy[]
  plans: DispatchPlan[]
  lastSeq: number
}

export interface ApiError {
  error: string
  details?: unknown
}
