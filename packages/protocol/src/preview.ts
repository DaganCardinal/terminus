import { z } from "zod"

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const previewTokenSchema = z.string().regex(/^[a-f0-9]{24}$/)

/** A disposable application view pinned to one repository commit. */
export const repositoryPreviewSchema = z.object({
  commit: commitSchema,
  url: z.url({ protocol: /^https?$/ }),
})
export const trainPreviewSchema = repositoryPreviewSchema.extend({
  trainId: z.string().min(1),
})
export type TrainPreview = z.infer<typeof trainPreviewSchema>

export const terminusPreviewSchema = repositoryPreviewSchema.extend({
  networkId: z.string().min(1),
})
export type TerminusPreview = z.infer<typeof terminusPreviewSchema>

/** Commit identities are opaque here, including the offline environment's refs.
 * Live Sandbox requests separately require a full Git commit hash. */
export const terminusPreviewRequestSchema = z
  .object({ commit: z.string().min(1).max(200) })
  .strict()
export type TerminusPreviewRequest = z.infer<
  typeof terminusPreviewRequestSchema
>

export const sandboxPreviewRequestSchema = z.object({
  remote: z.url({ protocol: /^https$/ }),
  token: z.string().min(1),
  commit: commitSchema,
  hostname: z.string().regex(/^[a-z0-9.-]+$/),
})
export type SandboxPreviewRequest = z.infer<typeof sandboxPreviewRequestSchema>

export const sandboxPreviewResultSchema = z.object({
  token: previewTokenSchema,
})
export type SandboxPreviewResult = z.infer<typeof sandboxPreviewResultSchema>
