import {
  harnessRoles,
  roleExecutions,
  type ModelSettings,
} from "@terminus/protocol"

/** Fakes exercise every selection without enabling unverified paid execution. */
export function alternativeHarnessesEnabled(
  env: Pick<Env, "REPOSITORY_MODE" | "ALTERNATIVE_HARNESSES_ENABLED">
): boolean {
  return (
    env.REPOSITORY_MODE === "fake" ||
    env.ALTERNATIVE_HARNESSES_ENABLED === "true"
  )
}

export function unavailableHarnessSettings(
  env: Pick<Env, "REPOSITORY_MODE" | "ALTERNATIVE_HARNESSES_ENABLED">,
  settings: ModelSettings | null
): boolean {
  if (!settings || alternativeHarnessesEnabled(env)) return false
  const config = roleExecutions(settings)
  return harnessRoles.some(
    (role) =>
      config[role].harness !== "opencode" ||
      config[role].provider !== "workers-ai"
  )
}
