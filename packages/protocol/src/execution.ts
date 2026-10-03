import { z } from "zod"

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
})
export type SandboxNetwork = z.infer<typeof sandboxNetworkSchema>

export const modelCallSchema = z
  .object({ model: z.string().min(1) })
  .passthrough()
