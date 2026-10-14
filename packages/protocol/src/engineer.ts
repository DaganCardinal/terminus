import { z } from "zod"
import { checkResultSchema } from "./agents"
import { decisionAnswerSchema } from "./decision"
import { issueSchema, reviewFeedbackSchema } from "./events"

const boundedCheckSchema = checkResultSchema
  .extend({
    stdout: z.string().max(2_000).optional(),
    stderr: z.string().max(2_000).optional(),
  })
  .refine(
    (check) =>
      (check.stdout?.length ?? 0) + (check.stderr?.length ?? 0) <= 2_000,
    "Check diagnostics exceed 2,000 characters"
  )
const boundedFeedbackSchema = reviewFeedbackSchema.extend({
  summary: z.string().max(2_000),
  findings: z.array(z.string().max(2_000)).max(16),
})
export const engineerHistoryEntrySchema = z.object({
  runId: z.string(),
  at: z.string(),
  allowance: z.enum(["current", "historical"]),
  phase: z.string().max(200).optional(),
  issues: z
    .array(issueSchema.extend({ detail: z.string().max(2_000) }))
    .max(16)
    .optional(),
  feedback: boundedFeedbackSchema.optional(),
  checks: z.array(boundedCheckSchema).max(32).optional(),
  backoff: z.boolean().optional(),
  action: z.string().optional(),
  truncated: z.boolean().optional(),
})
export type EngineerHistoryEntry = z.infer<typeof engineerHistoryEntrySchema>
export const engineerContextSchema = z.object({
  history: z.array(engineerHistoryEntrySchema).max(4),
  checks: z.array(boundedCheckSchema).max(32).optional(),
  truncated: z.boolean().optional(),
})
export type EngineerContext = z.infer<typeof engineerContextSchema>

export const engineerAdviceSchema = z.object({
  value: z.union([z.string(), z.boolean()]),
  confidence: z.number().min(0).max(1).nullable(),
  answer: decisionAnswerSchema.optional(),
  fallback: z.boolean().optional(),
  error: z.string().optional(),
})
export const engineerAssessmentSchema = z
  .object({
    id: z.string(),
    trainId: z.string(),
    purpose: z.enum(["station_failure", "revision", "notify_dispatcher"]),
    model: z.string(),
    questionVersion: z.literal(1),
    threshold: z.number(),
    input: z.unknown(),
    advice: engineerAdviceSchema,
    assessedAt: z.string(),
  })
  .superRefine((record, ctx) => {
    const allowed =
      record.purpose === "station_failure"
        ? ["retry", "wait", "escalate"]
        : record.purpose === "revision"
          ? ["revise", "escalate"]
          : [true, false]
    if (!(allowed as (string | boolean)[]).includes(record.advice.value))
      ctx.addIssue({
        code: "custom",
        message: "Advice does not match the assessment purpose",
        path: ["advice", "value"],
      })
  })
export type EngineerAssessment = z.infer<typeof engineerAssessmentSchema>
export const engineerNoticeSchema = z.object({
  id: z.string(),
  trainId: z.string(),
  stationId: z.string().optional(),
  cause: z.enum(["recovery", "dependency"]),
  fingerprint: z.string(),
  summary: z.string().max(1_000),
  dependencyIds: z.array(z.string()),
  assessedAt: z.string(),
  waitingSince: z.string().optional(),
  acknowledgedAt: z.string().optional(),
  resolvedAt: z.string().optional(),
})
