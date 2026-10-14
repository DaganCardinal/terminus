import { z } from "zod"
import { issueSchema } from "./events"

export const checkResultSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  status: z.enum(["passed", "failed", "skipped"]),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  outputTruncated: z.boolean().optional(),
})

export const evidenceSchema = z.object({
  checks: z.array(checkResultSchema),
})

export const proposalSchema = z.object({
  headCommit: z.string().min(1),
  changedPaths: z.array(z.string()),
  diff: z.string().optional(),
  evidence: evidenceSchema,
  agent: z.object({
    harness: z.string(),
    model: z.string(),
    provider: z.string().optional(),
    harnessVersion: z.string().optional(),
  }),
  agentSummary: z.string().nullable(),
})

/** What a Station run reports to its Train when it finishes. */
export const stationRunResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), proposal: proposalSchema }),
  z.object({
    ok: z.literal(false),
    issues: z.array(issueSchema).min(1),
    phase: z.string().optional(),
  }),
])

export const stationOutcomeSchema = z.object({
  stationId: z.string(),
  runId: z.string(),
  result: stationRunResultSchema,
})

export type StationOutcome = z.infer<typeof stationOutcomeSchema>

/** A Conductor's structured review of Station work. */
export const conductorVerdictSchema = z.object({
  verdict: z.enum(["accept", "return", "escalate"]),
  summary: z.string(),
  findings: z.array(z.string()),
})

export type ConductorVerdict = z.infer<typeof conductorVerdictSchema>

/**
 * A verdict on Station work. A Station run that left its evidence to review
 * gets it here, collected by orchestration in the Conductor's clean checkout.
 */
export const stationVerdictSchema = conductorVerdictSchema.extend({
  evidence: evidenceSchema.optional(),
})

export type StationVerdict = z.infer<typeof stationVerdictSchema>
