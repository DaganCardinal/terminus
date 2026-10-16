import {
  catalogModel,
  validationCommandsSchema,
  stationMaxRetriesSchema,
  type RoleExecution,
  type SandboxNetwork,
  type ValidationCommand,
} from "@terminus/protocol"
import type { ModelTransport } from "@terminus/agent-runtime"
import { DEFAULT_STATION_MAX_RETRIES } from "@terminus/domain"
import { modelAccount } from "./cloudflare-account"

export function stationMaxRetries(
  env: Partial<Pick<Env, "STATION_MAX_RETRIES">>
): number {
  return stationMaxRetriesSchema.parse(
    Number(env.STATION_MAX_RETRIES ?? DEFAULT_STATION_MAX_RETRIES)
  )
}

export const gatewayTransport: ModelTransport = (url, { timeoutMs, ...init }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

export const defaultValidation: ValidationCommand[] =
  validationCommandsSchema.parse([
    { name: "typecheck", command: ["npm", "run", "typecheck"] },
    { name: "test", command: ["npm", "test"] },
    { name: "build", command: ["npm", "run", "build"] },
  ])

export function gatewayConfig(env: Env, model: string) {
  const { accountId, token } = modelAccount(env)
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new Error(
      "Configure CLOUDFLARE_ACCOUNT_ID before running real agents"
    )
  if (!env.AI_GATEWAY_ID || !/^[a-zA-Z0-9_-]+$/.test(env.AI_GATEWAY_ID))
    throw new Error("Configure AI_GATEWAY_ID before running real agents")
  if (!token)
    throw new Error(
      "Configure the CLOUDFLARE_RUNTIME_TOKEN Worker secret before running real agents"
    )
  const entry = catalogModel(model)
  return {
    accountId,
    gatewayId: env.AI_GATEWAY_ID,
    token,
    model,
    provider: entry.provider,
    apiModel: entry.apiModel,
  }
}

/**
 * The model a harness Sandbox may call: the role model, its provider when
 * that is not Workers AI, and the frozen reasoning level the outbound handler
 * applies to Workers AI calls.
 */
export function modelGrant(
  model: string,
  execution?: RoleExecution
): Pick<SandboxNetwork, "model" | "provider" | "reasoning"> {
  const { provider } = catalogModel(model)
  return {
    model,
    ...(provider === "workers-ai" ? {} : { provider }),
    ...(execution?.reasoning ? { reasoning: execution.reasoning } : {}),
  }
}
