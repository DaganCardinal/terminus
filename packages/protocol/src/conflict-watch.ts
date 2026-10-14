import { z } from "zod"

const findingSchema = z.object({
  kind: z.enum(["textual", "semantic"]),
  summary: z.string().max(2_000),
  paths: z.array(z.string()).max(100),
  details: z.array(z.string().max(2_000)).max(16),
  suggestedHold: z.string().optional(),
})

export const conflictPairSchema = z.object({
  otherTrainId: z.string(),
  otherLineId: z.string(),
  route: z.enum(["overlap", "triage"]),
  overlap: z.object({
    sharedPaths: z.array(z.string()),
    plannedAreas: z.array(
      z.object({ stationId: z.string(), paths: z.array(z.string()) })
    ),
    sharedContracts: z.array(z.string()),
    sharedDirectories: z.array(z.string()),
  }),
  stage: z.enum([
    "triage",
    "investigate",
    "confirmed",
    "dismissed",
    "failed",
    "skipped",
  ]),
  triage: z
    .object({
      likely: z.boolean(),
      probability: z.number().min(0).max(1).nullable(),
      model: z.string(),
      error: z.string().optional(),
    })
    .optional(),
  investigation: z
    .object({
      model: z.string(),
      commits: z.object({ train: z.string(), other: z.string() }),
      trialMerge: z
        .object({ clean: z.boolean(), conflictPaths: z.array(z.string()) })
        .nullable(),
      checks: z
        .array(z.object({ name: z.string(), status: z.string() }))
        .optional(),
      summary: z.string().max(2_000),
      finding: findingSchema.optional(),
    })
    .optional(),
  reason: z.string().optional(),
  reportedAt: z.string().optional(),
  acknowledgedAt: z.string().optional(),
})

export const conflictWatchSchema = z.object({
  id: z.string(),
  trainId: z.string(),
  lineId: z.string(),
  carId: z.string(),
  stationId: z.string(),
  createdAt: z.string(),
  baseline: z.boolean().optional(),
  pairs: z.array(conflictPairSchema),
})

/**
 * What the Dispatcher's investigation answers in its final message. Any
 * `suggestedHold` names which side to hold, never a Train id the model chose.
 */
export const conflictVerdictSchema = z.object({
  conflict: z.boolean(),
  summary: z.string().min(1).max(2_000),
  paths: z.array(z.string()).max(100).default([]),
  details: z.array(z.string().max(2_000)).max(16).default([]),
  suggestedHold: z.enum(["this", "other", "none"]).default("none"),
})
export type ConflictVerdict = z.infer<typeof conflictVerdictSchema>
