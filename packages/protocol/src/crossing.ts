import { z } from "zod"
import { workManifestSchema } from "./manifest"
import { evidenceSchema } from "./agents"
import { integrationAttemptSchema } from "./integration"
import { issueSchema } from "./events"
export const plannedStopSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("station"), key: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("crossing"),
      source: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("planned"), stationKey: z.string().min(1) })
          .strict(),
        z
          .object({ kind: z.literal("existing"), stationId: z.string().min(1) })
          .strict(),
      ]),
    })
    .strict(),
])
export const checkpointSchema = z.object({
  stationId: z.string(),
  sourceTrainId: z.string(),
  repoId: z.string(),
  commit: z.string(),
  carIds: z.array(z.string()),
})
export const crossingSchema = z.object({
  id: z.string(),
  networkId: z.string(),
  lineId: z.string(),
  sourceStationId: z.string(),
  checkpoint: checkpointSchema.optional(),
  attempt: z.number().int().nonnegative(),
  retryRequested: z.boolean().optional(),
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("waiting") }),
    z.object({ status: z.literal("integrating"), integrationId: z.string() }),
    z.object({
      status: z.literal("complete"),
      integrationId: z.string(),
      commit: z.string(),
      copiedCarIds: z.array(z.string()),
    }),
    z.object({
      status: z.literal("blocked"),
      issues: z.array(issueSchema),
      integrationId: z.string().optional(),
    }),
  ]),
})

export const carSchema = z.object({
  id: z.string(),
  trainId: z.string(),
  stationId: z.string(),
  position: z.number().int().positive(),
  manifest: workManifestSchema,
  stationAgent: z.object({ harness: z.string(), model: z.string() }),
  sourceCommit: z.string(),
  acceptedCommit: z.string(),
  changedPaths: z.array(z.string()),
  diff: z.string().optional(),
  evidence: evidenceSchema,
  agentSummary: z.string().nullable(),
  review: z.object({
    summary: z.string(),
    findings: z.array(z.string()),
    model: z.string(),
  }),
  acceptedAt: z.string(),
  originCarId: z.string().optional(),
  sourceCarId: z.string().optional(),
  crossingId: z.string().optional(),
  copiedAt: z.string().optional(),
})
export const crossingReviewInputSchema = z.object({
  kind: z.literal("crossing"),
  crossingId: z.string(),
  sourceStationId: z.string(),
  sourceCommit: z.string(),
  targetCommit: z.string(),
  candidateCommit: z.string(),
  diff: z.string(),
  changedPaths: z.array(z.string()),
  evidence: evidenceSchema,
  sourceCars: z.array(carSchema),
  receivingCars: z.array(carSchema),
  downstreamManifests: z.array(workManifestSchema),
})
export type CrossingReviewInput = z.infer<typeof crossingReviewInputSchema>
export const crossingDetailsSchema = z.object({
  crossing: crossingSchema,
  checkpoint: checkpointSchema.nullable(),
  attempts: z.array(integrationAttemptSchema),
  cars: z.array(carSchema),
})
