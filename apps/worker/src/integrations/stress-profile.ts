import {
  PIPELINE_STRESS_PROFILE,
  type RoleExecutions,
} from "@terminus/protocol"

/** Test execution is immutable per Train and independent of deployment settings. */
export function stressProfile(config: RoleExecutions | undefined): boolean {
  return config?.pipelineStress === PIPELINE_STRESS_PROFILE
}
