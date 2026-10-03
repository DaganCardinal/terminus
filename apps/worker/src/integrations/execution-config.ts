import {
  validationCommandsSchema,
  type ValidationCommand,
} from "@terminus/protocol"
import type { ModelTransport } from "@terminus/agent-runtime"

export const gatewayTransport: ModelTransport = (url, { timeoutMs, ...init }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

export const defaultValidation: ValidationCommand[] =
  validationCommandsSchema.parse([
    { name: "typecheck", command: ["npm", "run", "typecheck"] },
    { name: "test", command: ["npm", "test"] },
    { name: "build", command: ["npm", "run", "build"] },
  ])

export function gatewayConfig(env: Env, model: string) {
  if (
    !env.AI_GATEWAY_ACCOUNT_ID ||
    !/^[a-f0-9]{32}$/.test(env.AI_GATEWAY_ACCOUNT_ID)
  )
    throw new Error(
      "Configure AI_GATEWAY_ACCOUNT_ID before running real agents"
    )
  if (!env.AI_GATEWAY_ID || !/^[a-zA-Z0-9_-]+$/.test(env.AI_GATEWAY_ID))
    throw new Error("Configure AI_GATEWAY_ID before running real agents")
  if (!env.AI_GATEWAY_TOKEN)
    throw new Error(
      "Configure the AI_GATEWAY_TOKEN Worker secret before running real agents"
    )
  if (!model.startsWith("@cf/"))
    throw new Error("Configure a Workers AI model identity for the role")
  return {
    accountId: env.AI_GATEWAY_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    token: env.AI_GATEWAY_TOKEN,
    model,
  }
}
