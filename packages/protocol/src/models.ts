import { z } from "zod"

/**
 * Curated models a role can be configured with. Text models write plans,
 * reviews, and code; decision models only score fixed answer options.
 */
export const HARNESS_CATALOG = [
  { id: "opencode", name: "OpenCode", version: "1.18.32" },
  { id: "claude-code", name: "Claude Code", version: "2.1.280" },
  { id: "codex", name: "Codex", version: "0.156.1" },
] as const
export const harnessSchema = z.enum(["opencode", "claude-code", "codex"])
export type Harness = z.infer<typeof harnessSchema>
export const harnessRoles = [
  "dispatcher",
  "conductor",
  "stationAgent",
  "technician",
] as const
export type HarnessRole = (typeof harnessRoles)[number]
export const DEFAULT_ROLE_HARNESSES = {
  dispatcher: "opencode",
  conductor: "opencode",
  stationAgent: "opencode",
  technician: "opencode",
} as const
export const roleHarnessesSchema = z.strictObject({
  dispatcher: harnessSchema,
  conductor: harnessSchema,
  stationAgent: harnessSchema,
  technician: harnessSchema,
})
export type RoleHarnesses = z.infer<typeof roleHarnessesSchema>
export const modelProviderSchema = z.enum(["workers-ai", "anthropic", "openai"])
export type ModelProviderId = z.infer<typeof modelProviderSchema>

export const MODEL_CATALOG = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    apiModel: "@cf/zai-org/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    maker: "Z.ai",
    kind: "text",
    provider: "workers-ai",
    harnesses: ["opencode"],
    costOrder: 0,
  },
  {
    id: "@cf/zai-org/glm-5.3",
    apiModel: "@cf/zai-org/glm-5.3",
    name: "GLM-5.3",
    maker: "Z.ai",
    kind: "text",
    provider: "workers-ai",
    harnesses: ["opencode"],
    costOrder: 2,
  },
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    apiModel: "@cf/moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    maker: "Moonshot AI",
    kind: "text",
    provider: "workers-ai",
    harnesses: ["opencode"],
    costOrder: 3,
  },
  {
    id: "@cf/cloudflare/clef-flash",
    apiModel: "@cf/cloudflare/clef-flash",
    name: "Clef Flash",
    maker: "Cloudflare",
    kind: "decision",
    provider: "workers-ai",
    harnesses: [],
    costOrder: 0,
  },
  {
    id: "@cf/cloudflare/clef",
    apiModel: "@cf/cloudflare/clef",
    name: "Clef",
    maker: "Cloudflare",
    kind: "decision",
    provider: "workers-ai",
    harnesses: [],
    costOrder: 1,
  },
  {
    id: "anthropic/claude-haiku-4-5-20251001",
    apiModel: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    maker: "Anthropic",
    kind: "text",
    provider: "anthropic",
    harnesses: ["opencode", "claude-code"],
    costOrder: 4,
  },
  {
    id: "anthropic/claude-sonnet-5-5",
    apiModel: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    maker: "Anthropic",
    kind: "text",
    provider: "anthropic",
    harnesses: ["opencode", "claude-code"],
    costOrder: 5,
  },
  {
    id: "openai/gpt-6-luna",
    apiModel: "gpt-6-luna",
    name: "GPT-6 Luna",
    maker: "OpenAI",
    kind: "text",
    provider: "openai",
    harnesses: ["opencode", "codex"],
    costOrder: 1,
  },
  {
    id: "openai/gpt-6-sol",
    apiModel: "gpt-6-sol",
    name: "GPT-6 Sol",
    maker: "OpenAI",
    kind: "text",
    provider: "openai",
    harnesses: ["opencode", "codex"],
    costOrder: 6,
  },
] as const

export function catalogModel(id: string) {
  const model = MODEL_CATALOG.find((entry) => entry.id === id)
  if (!model) throw new Error(`Unknown curated model: ${id}`)
  return model
}
export function compatibleModels(harness: Harness) {
  return MODEL_CATALOG.filter(
    (model) =>
      model.kind === "text" &&
      (model.harnesses as readonly string[]).includes(harness)
  ).sort((a, b) => a.costOrder - b.costOrder)
}
export function compatibleModel(harness: Harness, model: string): boolean {
  return compatibleModels(harness).some((entry) => entry.id === model)
}
export function modelForHarness(harness: Harness, current: string): string {
  return compatibleModel(harness, current)
    ? current
    : compatibleModels(harness)[0]!.id
}
export function harnessIdentity(harness: Harness): string {
  return `${harness}@${HARNESS_CATALOG.find((entry) => entry.id === harness)!.version}`
}
export function harnessFromIdentity(identity?: string): Harness {
  if (!identity) return "opencode"
  return harnessSchema.parse(identity.split("@")[0])
}
export const roleExecutionSchema = z
  .strictObject({
    harness: harnessSchema,
    model: z.string().min(1),
    version: z.string().min(1).optional(),
    provider: modelProviderSchema.optional(),
  })
  .refine(
    (value) => compatibleModel(value.harness, value.model),
    "Model is incompatible with the selected harness"
  )
  .refine(
    (value) =>
      !value.provider ||
      !compatibleModel(value.harness, value.model) ||
      value.provider === catalogModel(value.model).provider,
    "Provider differs from the curated model"
  )
export type RoleExecution = z.infer<typeof roleExecutionSchema>
export const roleExecutionsSchema = z.strictObject({
  dispatcher: roleExecutionSchema,
  conductor: roleExecutionSchema,
  stationAgent: roleExecutionSchema,
  technician: roleExecutionSchema,
  engineer: z.string().min(1),
})
export type RoleExecutions = z.infer<typeof roleExecutionsSchema>

export type CatalogModel = (typeof MODEL_CATALOG)[number]

const ids = <K extends CatalogModel["kind"]>(kind: K) =>
  MODEL_CATALOG.filter(
    (model): model is Extract<CatalogModel, { kind: K }> => model.kind === kind
  ).map((model) => model.id) as [
    Extract<CatalogModel, { kind: K }>["id"],
    ...Extract<CatalogModel, { kind: K }>["id"][],
  ]

export const textModelSchema = z.enum(ids("text"))
/** The Engineer only answers fixed questions, so it uses a decision model. */
export const decisionModelSchema = z.enum(ids("decision"))

export const roleModelsSchema = z.strictObject({
  dispatcher: textModelSchema,
  conductor: textModelSchema,
  stationAgent: textModelSchema,
  technician: textModelSchema,
  engineer: decisionModelSchema,
})
export type RoleModels = z.infer<typeof roleModelsSchema>
export type ModelRole = keyof RoleModels

export const fixedModelPresetSchema = z.enum(["extra_light", "light", "medium"])
export type FixedModelPreset = z.infer<typeof fixedModelPresetSchema>
export type ModelPreset = FixedModelPreset | "custom"

/** A preset names its models; only a custom selection carries them. */
export const modelSettingsSchema = z
  .discriminatedUnion("preset", [
    z.strictObject({ preset: fixedModelPresetSchema }),
    z.strictObject({
      preset: z.literal("custom"),
      models: roleModelsSchema,
      harnesses: roleHarnessesSchema.optional(),
    }),
  ])
  .superRefine((settings, context) => {
    if (settings.preset !== "custom") return
    for (const role of harnessRoles) {
      if (
        !compatibleModel(
          settings.harnesses?.[role] ?? "opencode",
          settings.models[role]
        )
      )
        context.addIssue({
          code: "custom",
          path: ["models", role],
          message: "Model is incompatible with the selected harness",
        })
    }
  })
export type ModelSettings = z.infer<typeof modelSettingsSchema>

const flash = "@cf/zai-org/glm-5.3-flash"
const glm = "@cf/zai-org/glm-5.3"

export const MODEL_PRESETS: Record<FixedModelPreset, RoleModels> = {
  extra_light: {
    dispatcher: flash,
    conductor: flash,
    stationAgent: flash,
    technician: flash,
    engineer: "@cf/cloudflare/clef-flash",
  },
  light: {
    dispatcher: glm,
    conductor: flash,
    stationAgent: flash,
    technician: flash,
    engineer: "@cf/cloudflare/clef-flash",
  },
  medium: {
    dispatcher: glm,
    conductor: glm,
    stationAgent: "@cf/moonshotai/kimi-k2.7-code",
    technician: glm,
    engineer: "@cf/cloudflare/clef",
  },
}

/** What every network uses until someone chooses otherwise. */
export const DEFAULT_MODEL_SETTINGS: ModelSettings = { preset: "extra_light" }

export function roleModels(settings: ModelSettings): RoleModels {
  return settings.preset === "custom"
    ? settings.models
    : MODEL_PRESETS[settings.preset]
}

/** The General settings, which every network follows unless it overrides them. */
export const generalModelSettingsSchema = z.strictObject({
  settings: modelSettingsSchema,
  alternativeHarnessesEnabled: z.boolean().optional(),
  /** Null until someone saves; the defaults apply until then. */
  updatedAt: z.iso.datetime().nullable(),
})
export type GeneralModelSettings = z.infer<typeof generalModelSettingsSchema>

export const networkModelSettingsSchema = z.strictObject({
  alternativeHarnessesEnabled: z.boolean().optional(),
  /** Null follows the General settings. */
  override: modelSettingsSchema.nullable(),
  general: modelSettingsSchema,
  updatedAt: z.iso.datetime().nullable(),
})
export type NetworkModelSettings = z.infer<typeof networkModelSettingsSchema>

export const setNetworkModelSettingsRequestSchema = z.strictObject({
  override: modelSettingsSchema.nullable(),
})
export type SetNetworkModelSettingsRequest = z.infer<
  typeof setNetworkModelSettingsRequestSchema
>

/** The models a network's roles run with right now. */
export function effectiveRoleModels(
  settings: Pick<NetworkModelSettings, "override" | "general">
): RoleModels {
  return roleModels(settings.override ?? settings.general)
}

export function roleHarnesses(settings: ModelSettings): RoleHarnesses {
  return settings.preset === "custom"
    ? (settings.harnesses ?? { ...DEFAULT_ROLE_HARNESSES })
    : { ...DEFAULT_ROLE_HARNESSES }
}
export function roleExecutions(settings: ModelSettings): RoleExecutions {
  const models = roleModels(settings)
  const harnesses = roleHarnesses(settings)
  return {
    engineer: models.engineer,
    ...Object.fromEntries(
      harnessRoles.map((role) => [
        role,
        {
          harness: harnesses[role],
          model: models[role],
          version: HARNESS_CATALOG.find(
            (entry) => entry.id === harnesses[role]
          )!.version,
          provider: catalogModel(models[role]).provider,
        },
      ])
    ),
  } as RoleExecutions
}
