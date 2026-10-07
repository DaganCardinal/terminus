import {
  harnessMessage,
  harnessPreflightCommand,
  harnessPreflightGuidance,
  opencodeConfig,
  opencodeEnvironment,
  opencodeRunCommand,
  type HarnessAgent,
} from "@terminus/agent-runtime"
import type { GitWorkspace } from "@terminus/artifacts"
import { commandResultSchema } from "@terminus/protocol"
import { gatewayConfig } from "./execution-config"
import type { StationSandbox } from "./station-runner"

export interface HarnessRequest {
  model: string
  agent: HarnessAgent
  /** The untrusted checkout the agent works in. */
  directory: string
  /** The role's assignment; root repository guidance is attached as data. */
  assignment: string
}

export interface PreparedHarness {
  command: string[]
  env: Record<string, string>
}

/**
 * Prepares any role's OpenCode run over an untrusted checkout. Call it
 * immediately before running the harness: it writes the only configuration
 * the harness loads, and removes user-level configuration that repository
 * code may have written since the Sandbox started.
 */
export async function prepareHarness(
  env: Env,
  sandbox: Pick<StationSandbox, "write">,
  workspace: Pick<GitWorkspace, "run">,
  request: HarnessRequest
): Promise<PreparedHarness> {
  const { accountId, gatewayId, model } = gatewayConfig(env, request.model)
  await sandbox.write(
    opencodeEnvironment.OPENCODE_CONFIG,
    opencodeConfig(accountId, gatewayId, model, request.agent)
  )
  const guidance = harnessPreflightGuidance(
    commandResultSchema.parse(
      await workspace.run(harnessPreflightCommand(), request.directory)
    )
  )
  return {
    command: opencodeRunCommand(
      request.agent.name,
      model,
      harnessMessage(request.assignment, guidance, crypto.randomUUID())
    ),
    env: { ...opencodeEnvironment },
  }
}
