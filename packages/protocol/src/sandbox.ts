import { z } from "zod"

export const stopStationSandboxRequestSchema = z
  .object({
    runId: z.string().min(1).max(300),
    discardUnpublishedCandidate: z.boolean().default(false),
  })
  .strict()
export type StopStationSandboxRequest = z.infer<
  typeof stopStationSandboxRequestSchema
>

export const emergencyBrakeRequestSchema = z
  .object({ discardUnfinishedWork: z.literal(true) })
  .strict()
export const emergencyBrakeResultSchema = z.object({
  holdId: z.string(),
  cleanedUpRunIds: z.array(z.string()),
  failures: z.array(z.object({ runId: z.string(), detail: z.string() })),
})
export type EmergencyBrakeResult = z.infer<typeof emergencyBrakeResultSchema>
