import { harnessEventSchema, type CommandResult } from "@terminus/protocol"
import type { StationRunInput } from "./roles"

export function stationPrompt(input: StationRunInput): string {
  return [
    "Implement exactly this Terminus Work Manifest in the current Station repository.",
    "Read AGENTS.md if present. Preserve existing behaviour and avoid the listed areas.",
    "Commit your candidate changes locally. Do not push, edit Git remotes, rewrite history, or accept your own work.",
    "Orchestration independently validates and pushes the result. Your summary is not validation evidence.",
    `Manifest: ${JSON.stringify(input.manifest)}`,
    input.feedback
      ? `Conductor revision feedback: ${JSON.stringify(input.feedback)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** An explicit provider/model avoids harness defaults or model-list fallbacks. */
export function opencodeConfig(
  accountId: string,
  gatewayId: string,
  model: string
): string {
  return JSON.stringify({
    // Terminus owns candidate history. OpenCode's optional snapshot subprocesses
    // can hang in the Sandbox, preventing the harness from exiting.
    snapshot: false,
    enabled_providers: ["terminus"],
    model: `terminus/${model}`,
    small_model: `terminus/${model}`,
    provider: {
      terminus: {
        npm: "@ai-sdk/openai-compatible",
        name: "Terminus Workers AI",
        options: {
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
          apiKey: "provided-by-worker",
          headers: { "cf-aig-gateway-id": gatewayId },
        },
        models: {
          [model]: {
            name: model,
            tool_call: true,
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            limit: { context: 131072, output: 8192 },
          },
        },
      },
    },
  })
}

export function opencodeCommand(
  model: string,
  input: StationRunInput
): string[] {
  return [
    "opencode",
    "run",
    "--format",
    "json",
    "--auto",
    "--model",
    `terminus/${model}`,
    "--",
    stationPrompt(input),
  ]
}

export function harnessOutcome(output: CommandResult): {
  summary: string | null
  error: string | null
} {
  let summary: string | null = null
  let error: string | null = null
  for (const line of output.stdout.split("\n")) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = harnessEventSchema.safeParse(value)
    if (!parsed.success) continue
    if (parsed.data.type === "text") summary = parsed.data.part.text
    else error = parsed.data.error.data?.message ?? parsed.data.error.name
  }
  if (output.exitCode !== 0) error ??= `OpenCode exited with ${output.exitCode}`
  if (output.outputTruncated)
    error ??= "OpenCode output exceeded the capture limit"
  return { summary, error }
}
