import {
  harnessRoles,
  roleExecutions,
  type Harness,
  type ModelProviderId,
  type ModelSettings,
} from "@terminus/protocol"

type GateEnv = Pick<
  Env,
  | "REPOSITORY_MODE"
  | "ALTERNATIVE_HARNESSES_ENABLED"
  | "OPENCODE_EXTERNAL_PROVIDERS_ENABLED"
>

/**
 * Whether a real deployment may run a harness with a provider. OpenCode on
 * Workers AI always may. Claude Code and Codex need the alternative-harness
 * gate. OpenCode on Anthropic or OpenAI also needs its own gate, because no
 * OpenCode run has called those providers live yet.
 */
export function harnessExecutionEnabled(
  env: Omit<GateEnv, "REPOSITORY_MODE">,
  harness: Harness,
  provider: ModelProviderId
): boolean {
  if (harness === "opencode" && provider === "workers-ai") return true
  if (env.ALTERNATIVE_HARNESSES_ENABLED !== "true") return false
  return (
    harness !== "opencode" || env.OPENCODE_EXTERNAL_PROVIDERS_ENABLED === "true"
  )
}

/** Fakes exercise every selection without enabling unverified paid execution. */
export function alternativeHarnessesEnabled(env: GateEnv): boolean {
  return (
    env.REPOSITORY_MODE === "fake" ||
    env.ALTERNATIVE_HARNESSES_ENABLED === "true"
  )
}

export function opencodeExternalProvidersEnabled(env: GateEnv): boolean {
  return (
    env.REPOSITORY_MODE === "fake" ||
    harnessExecutionEnabled(env, "opencode", "anthropic")
  )
}

export function unavailableHarnessSettings(
  env: GateEnv,
  settings: ModelSettings | null
): boolean {
  if (!settings || env.REPOSITORY_MODE === "fake") return false
  const config = roleExecutions(settings)
  return harnessRoles.some(
    (role) =>
      !harnessExecutionEnabled(
        env,
        config[role].harness,
        config[role].provider ?? "workers-ai"
      )
  )
}
