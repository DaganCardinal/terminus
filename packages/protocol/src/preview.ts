import { z } from "zod"

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const previewTokenSchema = z.string().regex(/^[a-f0-9]{24}$/)

/** A preview is a disposable view of an accepted Train snapshot. */
export const trainPreviewSchema = z.object({
  trainId: z.string().min(1),
  commit: commitSchema,
  url: z.url({ protocol: /^https?$/ }),
})
export type TrainPreview = z.infer<typeof trainPreviewSchema>

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
