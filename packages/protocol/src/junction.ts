import { z } from "zod"
import { workManifestSchema } from "./manifest"
import { evidenceSchema } from "./agents"
import { issueSchema } from "./events"
import { validationCommandsSchema } from "./execution"
import { plannedStopSchema, carSchema } from "./crossing"

export const lineOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("depot") }),
  z.object({ kind: z.literal("junction"), junctionId: z.string().min(1) }),
])
export const lineDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminus") }),
  z.object({ kind: z.literal("junction"), junctionId: z.string().min(1) }),
])
export const featureBriefSchema = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    scope: z.array(z.string().min(1)).min(1),
    contracts: workManifestSchema.shape.contracts,
    invariants: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    validation: validationCommandsSchema,
  })
  .strict()
const review = z.object({
  verdict: z.enum(["accept", "return", "escalate"]),
  summary: z.string(),
  findings: z.array(z.string()),
  model: z.string(),
})
export const junctionAcceptanceSchema = z.object({
  commit: z.string(),
  evidence: evidenceSchema,
  review,
  diff: z.string(),
  changedPaths: z.array(z.string()),
})
export const junctionInputSchema = z.object({
  trainId: z.string(),
  lineId: z.string(),
  sourceCommit: z.string(),
  integrationId: z.string(),
  mergeCommit: z.string(),
  carIds: z.array(z.string()),
})
export const junctionSchema = z.object({
  id: z.string(),
  networkId: z.string(),
  name: z.string(),
  repoId: z.string(),
  terminusBaseline: z.string(),
  headCommit: z.string(),
  incomingLineIds: z.array(z.string()).min(2),
  incomingTrainIds: z.array(z.string()).min(2),
  outgoingLineId: z.string(),
  outgoingTrainId: z.string(),
  outgoingUnloadMode: z.enum(["auto", "human_approval"]),
  brief: featureBriefSchema,
  conductorModel: z.string(),
  createdAt: z.string(),
  requestFingerprint: z.string().optional(),
  inputs: z.array(junctionInputSchema),
  repairIds: z.array(z.string()),
  acceptance: junctionAcceptanceSchema.optional(),
  attempt: z.number().int().nonnegative(),
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("collecting") }),
    z.object({ status: z.literal("reviewing") }),
    z.object({ status: z.literal("ready") }),
    z.object({ status: z.literal("released"), commit: z.string() }),
    z.object({
      status: z.literal("blocked"),
      issues: z.array(issueSchema).min(1),
      integrationId: z.string().optional(),
    }),
    z.object({ status: z.literal("abandoned"), reason: z.string() }),
  ]),
})
const station = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  manifest: workManifestSchema,
})
export const junctionLinePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    stations: z.array(station).max(24),
    route: z.array(plannedStopSchema).optional(),
    unloadMode: z.enum(["auto", "human_approval"]).optional(),
  })
  .strict()
export const createJunctionRequestSchema = z
  .object({
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    brief: featureBriefSchema,
    incoming: z
      .array(
        junctionLinePlanSchema.extend({
          stations: z.array(station).min(1).max(24),
          unloadMode: z.literal("auto").optional(),
        })
      )
      .min(2)
      .max(8),
    outgoing: junctionLinePlanSchema,
  })
  .strict()
export type CreateJunctionRequest = z.infer<typeof createJunctionRequestSchema>
export const releaseJunctionRequestSchema = z
  .object({ commit: z.string().min(1) })
  .strict()
export const junctionReviewInputSchema = z.object({
  kind: z.enum(["junction_input", "junction_feature"]),
  junctionId: z.string(),
  brief: featureBriefSchema,
  sourceCommit: z.string(),
  targetCommit: z.string(),
  candidateCommit: z.string(),
  diff: z.string(),
  changedPaths: z.array(z.string()),
  evidence: evidenceSchema,
  sourceCars: z.array(carSchema),
  receivingCars: z.array(carSchema),
  repairIds: z.array(z.string()),
  integrationReviews: z
    .array(
      z.object({
        id: z.string(),
        sourceCommit: z.string(),
        candidateCommit: z.string().optional(),
        diff: z.string().optional(),
        evidence: evidenceSchema.nullable(),
        review: review.nullable(),
      })
    )
    .optional(),
  repairs: z
    .array(
      z.object({
        id: z.string(),
        scope: z.array(z.string()),
        description: z.string(),
        candidateCommit: z.string().optional(),
        diff: z.string().optional(),
        repairDiff: z.string().optional(),
        evidence: evidenceSchema.optional(),
        review: review.optional(),
      })
    )
    .optional(),
})
export type JunctionReviewInput = z.infer<typeof junctionReviewInputSchema>
export const junctionRepairRequestSchema = z
  .object({
    failureId: z.string().min(1),
    scope: z.array(z.string().min(1)).min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict()
