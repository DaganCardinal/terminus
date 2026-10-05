import { z } from "zod"
import { evidenceSchema } from "./agents"
import { holdReasonSchema, issueSchema } from "./events"
import { validationCommandsSchema } from "./execution"

const repositoryRef = { repoId: z.string().min(1), commit: z.string().min(1) }
export const integrationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("train"),
    trainId: z.string().min(1),
    ...repositoryRef,
  }),
  z.object({
    kind: z.literal("checkpoint"),
    crossingId: z.string().min(1),
    ...repositoryRef,
  }),
  z.object({
    kind: z.literal("junction"),
    junctionId: z.string().min(1),
    ...repositoryRef,
  }),
])
export const integrationTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminus"),
    networkId: z.string().min(1),
    ...repositoryRef,
  }),
  z.object({
    kind: z.literal("train"),
    trainId: z.string().min(1),
    ...repositoryRef,
  }),
  z.object({
    kind: z.literal("junction"),
    junctionId: z.string().min(1),
    ...repositoryRef,
  }),
])
const legacyIntegrationInputSchema = z
  .object({
    source: integrationSourceSchema.optional(),
    target: integrationTargetSchema.optional(),
    purpose: z.enum(["terminus", "crossing", "junction"]).optional(),
    junctionId: z.string().optional(),
    crossingId: z.string().optional(),
    conductorModel: z.string().optional(),
    repairId: z.string().min(1).optional(),
    id: z.string().min(1),
    networkId: z.string().min(1),
    trainId: z.string().min(1),
    trainRepoId: z.string().min(1),
    trainCommit: z.string().min(1),
    trainBaseline: z.string().min(1),
    terminusRepoId: z.string().min(1),
    terminusCommit: z.string().min(1),
    acceptedCommits: z.array(z.string().min(1)),
    validation: validationCommandsSchema,
  })
  .refine(
    (i) =>
      (i.purpose !== "crossing" || (!!i.crossingId && !i.repairId)) &&
      (i.purpose !== "junction" || !!i.junctionId),
    "Crossing requires a Crossing identity and cannot use a Terminus repair"
  )
/** Normalize legacy field names once at the boundary; explicit refs are persisted for every purpose. */
export const integrationInputSchema = legacyIntegrationInputSchema.transform(
  (i, ctx) => {
    const purpose = i.purpose ?? "terminus"
    let source: z.infer<typeof integrationSourceSchema>,
      target: z.infer<typeof integrationTargetSchema>
    switch (purpose) {
      case "terminus":
        source = {
          kind: "train",
          trainId: i.trainId,
          repoId: i.trainRepoId,
          commit: i.trainCommit,
        }
        target = {
          kind: "terminus",
          networkId: i.networkId,
          repoId: i.terminusRepoId,
          commit: i.terminusCommit,
        }
        break
      case "crossing":
        source = {
          kind: "checkpoint",
          crossingId: i.crossingId!,
          repoId: i.trainRepoId,
          commit: i.trainCommit,
        }
        target = {
          kind: "train",
          trainId: i.trainId,
          repoId: i.terminusRepoId,
          commit: i.terminusCommit,
        }
        break
      case "junction":
        source =
          i.repairId && i.trainRepoId === i.terminusRepoId
            ? {
                kind: "junction",
                junctionId: i.junctionId!,
                repoId: i.trainRepoId,
                commit: i.trainCommit,
              }
            : {
                kind: "train",
                trainId: i.trainId,
                repoId: i.trainRepoId,
                commit: i.trainCommit,
              }
        target = {
          kind: "junction",
          junctionId: i.junctionId!,
          repoId: i.terminusRepoId,
          commit: i.terminusCommit,
        }
        break
      default: {
        const never: never = purpose
        throw new Error(`Unknown integration purpose ${never}`)
      }
    }
    if (
      (i.source && JSON.stringify(i.source) !== JSON.stringify(source)) ||
      (i.target && JSON.stringify(i.target) !== JSON.stringify(target))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Integration source/target references disagree with purpose or snapshots",
      })
    return { ...i, source, target } as z.infer<
      typeof legacyIntegrationInputSchema
    >
  }
)
export type IntegrationInput = z.infer<typeof integrationInputSchema>

export const integrationCandidateSchema = z.object({
  repoId: z.string().min(1),
  headCommit: z.string().min(1),
})
export type IntegrationCandidate = z.infer<typeof integrationCandidateSchema>

export const integrationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    mergeCommit: z.string().min(1),
    evidence: evidenceSchema,
  }),
  z.object({
    ok: z.literal(false),
    issues: z.array(issueSchema).min(1),
    holds: z.array(holdReasonSchema).min(1).optional(),
    conflictPaths: z.array(z.string()).optional(),
    evidence: evidenceSchema.optional(),
  }),
])
export type IntegrationResult = z.infer<typeof integrationResultSchema>

export const integrationAttemptSchema = z.object({
  input: integrationInputSchema,
  status: z.enum(["cleared", "prepared", "completed", "failed"]),
  candidate: integrationCandidateSchema.nullable(),
  evidence: evidenceSchema.nullable(),
  review: z
    .object({
      verdict: z.enum(["accept", "return", "escalate"]),
      summary: z.string(),
      findings: z.array(z.string()),
      model: z.string(),
    })
    .nullable()
    .optional(),
  diff: z.string().optional(),
  // An interruption may report a failed result while status stays active,
  // retaining clearance until explicit recovery reconciles the canonical head.
  result: integrationResultSchema.nullable(),
})
export type IntegrationAttempt = z.infer<typeof integrationAttemptSchema>

export const integrationOutcomeSchema = z.object({
  integrationId: z.string().min(1),
  result: integrationResultSchema,
})
export type IntegrationOutcome = z.infer<typeof integrationOutcomeSchema>
