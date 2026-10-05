import { z } from "zod"

/**
 * Workers AI models a role can be configured with. Text models write plans,
 * reviews, and code; decision models only score fixed answer options.
 */
export const MODEL_CATALOG = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    maker: "Z.ai",
    kind: "text",
  },
  { id: "@cf/zai-org/glm-5.3", name: "GLM-5.3", maker: "Z.ai", kind: "text" },
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    maker: "Moonshot AI",
    kind: "text",
  },
  {
    id: "@cf/cloudflare/clef-flash",
    name: "Clef Flash",
    maker: "Cloudflare",
    kind: "decision",
  },
  {
    id: "@cf/cloudflare/clef",
    name: "Clef",
    maker: "Cloudflare",
    kind: "decision",
  },
] as const

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
export const modelSettingsSchema = z.discriminatedUnion("preset", [
  z.strictObject({ preset: fixedModelPresetSchema }),
  z.strictObject({ preset: z.literal("custom"), models: roleModelsSchema }),
])
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
  /** Null until someone saves; the defaults apply until then. */
  updatedAt: z.iso.datetime().nullable(),
})
export type GeneralModelSettings = z.infer<typeof generalModelSettingsSchema>

export const networkModelSettingsSchema = z.strictObject({
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
