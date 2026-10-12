import { z } from "zod"

/** Observations only: these never drive orchestration or replace domain events. */
export const agentPhaseSchema = z.enum([
  "preparing_workspace",
  "waiting_for_sandbox",
  "checking_out",
  "checking_baseline",
  "sealing_workspace",
  "starting_agent",
  "exploring",
  "validating_proposal",
  "correcting_proposal",
  "closing_workspace",
  "saving_proposal",
  "simulation",
])

/** Only repository-relative paths, never queries, commands, prompts or results. */
export const activityPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_@./ -]+$/)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path
        .split("/")
        .some((segment) =>
          /^(?:\.\.?|\.env(?:\..*)?|\.git|\.claude|\.codex|\.agents)$/.test(
            segment
          )
        ) &&
      !/\.(?:pem|key|p12|pfx)$/i.test(path),
    "Expected a safe repository-relative path"
  )

export const agentActivitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase"), phase: agentPhaseSchema }).strict(),
  z
    .object({
      kind: z.literal("tool"),
      tool: z.enum(["read", "search", "list", "explore", "command"]),
      status: z.enum(["running", "completed", "failed"]),
      path: activityPathSchema.optional(),
    })
    .strict(),
])
export type AgentActivity = z.infer<typeof agentActivitySchema>
export type AgentPhase = z.infer<typeof agentPhaseSchema>
export type ActivityObserver = (activity: AgentActivity) => void

export const agentActivityEntrySchema = z.object({
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  activity: agentActivitySchema,
})
export type AgentActivityEntry = z.infer<typeof agentActivityEntrySchema>

export const dispatchActivityResponseSchema = z.object({
  attempt: z.string().nullable(),
  entries: z.array(agentActivityEntrySchema).max(100),
  lastSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
export type DispatchActivityResponse = z.infer<
  typeof dispatchActivityResponseSchema
>
