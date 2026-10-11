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

/**
 * The platform ceiling on concurrent containers of one Sandbox class. It
 * matches `max_instances` in `apps/worker/wrangler.jsonc`; no setting can
 * exceed it.
 */
export const MAX_SANDBOX_INSTANCES = 100

const sandboxLimitSchema = z.number().int().min(1).max(MAX_SANDBOX_INSTANCES)

/**
 * How many Sandboxes of each kind one network may run at once. Agent
 * Sandboxes run harnesses (Station, Conductor, Dispatcher, Technician);
 * agentless ones run Git, validation and previews.
 */
export const sandboxLimitsSchema = z.strictObject({
  agent: sandboxLimitSchema,
  agentless: sandboxLimitSchema,
})
export type SandboxLimits = z.infer<typeof sandboxLimitsSchema>
export type SandboxKind = keyof SandboxLimits

/** What every network uses until someone chooses otherwise. */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  agent: 10,
  agentless: 10,
}

/** The General limits, which every network follows unless it overrides them. */
export const generalSandboxLimitsSchema = z.strictObject({
  limits: sandboxLimitsSchema,
  /** Null until someone saves; the defaults apply until then. */
  updatedAt: z.iso.datetime().nullable(),
})
export type GeneralSandboxLimits = z.infer<typeof generalSandboxLimitsSchema>

export const networkSandboxLimitsSchema = z.strictObject({
  /** Null follows the General limits. */
  override: sandboxLimitsSchema.nullable(),
  general: sandboxLimitsSchema,
  updatedAt: z.iso.datetime().nullable(),
})
export type NetworkSandboxLimits = z.infer<typeof networkSandboxLimitsSchema>

export const setNetworkSandboxLimitsRequestSchema = z.strictObject({
  override: sandboxLimitsSchema.nullable(),
})
