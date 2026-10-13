import { z } from "zod"

/**
 * One stage of the deployed Browser Run transport proof, as the in-Sandbox
 * client reports it. Passed stages carry their own evidence fields.
 */
export const browserRunProofStageSchema = z.looseObject({
  name: z.string(),
  passed: z.boolean(),
  error: z.string().optional(),
})

/** What the in-Sandbox proof client prints. */
export const browserRunProofReportSchema = z.object({
  passed: z.boolean(),
  results: z.array(browserRunProofStageSchema),
})

/**
 * The deployed Browser Run transport proof's result. It passes only when the
 * client ran every stage and each one passed. Screenshot pixels never leave
 * the Sandbox; only their metadata does.
 */
export const browserRunProofSchema = z.object({
  passed: z.boolean(),
  sandbox: z.string(),
  durationMs: z.number().int().nonnegative(),
  stages: z.array(browserRunProofStageSchema),
  /** Why the proof could not run its stages, or could not read their report. */
  error: z.string().optional(),
  exitCode: z.number().int().optional(),
  stderr: z.string().optional(),
})
export type BrowserRunProof = z.infer<typeof browserRunProofSchema>
