import { z } from "zod"

export const unloadModeSchema = z.enum(["auto", "human_approval"])
export const unloadRecommendationSchema = z.strictObject({
  mode: unloadModeSchema,
  reason: z.string().trim().min(1).max(2000),
})
export const trainUnloadPolicySchema = z.strictObject({
  trainId: z.string().min(1),
  mode: unloadModeSchema,
  recommendation: unloadRecommendationSchema.optional(),
  approval: z
    .strictObject({
      trainCommit: z.string().min(1),
      approvedAt: z.iso.datetime(),
    })
    .optional(),
})
export const setUnloadModeRequestSchema = z.strictObject({
  mode: unloadModeSchema,
})
export const approveUnloadRequestSchema = z.strictObject({
  trainCommit: z.string().min(1),
})
