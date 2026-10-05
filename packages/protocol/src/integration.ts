import { z } from "zod"
import { evidenceSchema } from "./agents"
import { holdReasonSchema, issueSchema } from "./events"
import { validationCommandsSchema } from "./execution"

export const integrationInputSchema = z
  .object({
    purpose: z.enum(["terminus", "crossing"]).optional(),
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
    (i) => i.purpose !== "crossing" || (!!i.crossingId && !i.repairId),
    "Crossing requires a Crossing identity and cannot use a Terminus repair"
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
