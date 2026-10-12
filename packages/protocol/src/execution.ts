import type { BaselineReport, PlanningContext } from "@terminus/domain"
import { z } from "zod"
import { modelProviderSchema } from "./models"

const isObject = (value: unknown) => typeof value === "object" && value !== null

export const stationMaxRetriesSchema = z.number().int().nonnegative()

export const commandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean().optional(),
})
export type CommandResult = z.infer<typeof commandResultSchema>

export const validationCommandSchema = z.object({
  name: z.string().trim().min(1),
  command: z.array(z.string().min(1)).min(1),
})
export const validationCommandsSchema = z
  .array(validationCommandSchema)
  .min(1)
  .refine(
    (commands) =>
      new Set(commands.map((command) => command.name)).size === commands.length,
    "Validation names must be unique"
  )
export type ValidationCommand = z.infer<typeof validationCommandSchema>

/** The pinned harness emits additional event types; these are the outcome events. */
export const harnessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), part: z.object({ text: z.string() }) }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      name: z.string(),
      data: z.object({ message: z.string().optional() }).optional(),
    }),
  }),
  /** A proposal the Dispatcher submitted through its proposal tool. */
  z.object({ type: z.literal("submission"), proposal: z.unknown() }),
])

export const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable() }),
      })
    )
    .min(1),
})

export const sandboxNetworkSchema = z.object({
  repositories: z.array(
    z.object({
      remote: z.url(),
      token: z.string().min(1),
      scope: z.enum(["read", "write"]),
    })
  ),
  allowModel: z.boolean(),
  /**
   * The one role model this Sandbox's harness may call, resolved by
   * orchestration. Its `utilityModel` from the same provider is also allowed,
   * for the harness's own housekeeping calls.
   */
  model: z.string().min(1).optional(),
  provider: modelProviderSchema.optional(),
  /**
   * Routes the Sandbox's Workers AI requests to one model instance, so the
   * prompt prefix every harness turn repeats is read from its cache. The
   * Sandbox sets it from its own identity.
   */
  sessionAffinity: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  /**
   * Lets a planning harness check its proposal while it works, through the
   * outbound handler's proposal tool. The check is advisory: the Workflow
   * validates the final proposal again. Orchestration supplies the planning
   * context, never the Sandbox.
   */
  proposalCheck: z
    .object({
      network: z.custom<PlanningContext>(isObject),
      baseline: z.custom<BaselineReport>(isObject).nullable(),
    })
    .optional(),
})
export type SandboxNetwork = z.infer<typeof sandboxNetworkSchema>

export const modelCallSchema = z
  .object({ model: z.string().min(1) })
  .passthrough()

/** Native outcome events only; raw tool arguments/results never leave a Sandbox. */
export const claudeResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  session_id: z.string().optional(),
})
export const codexOutcomeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.started"), thread_id: z.string().min(1) }),
  z.object({ type: z.literal("turn.completed") }),
  z.object({
    type: z.literal("turn.failed"),
    error: z.object({ message: z.string() }),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("item.completed"),
    item: z.object({ type: z.literal("agent_message"), text: z.string() }),
  }),
])
