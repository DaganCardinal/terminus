import {
  catalogModel,
  claudeResultSchema,
  codexOutcomeEventSchema,
  harnessIdentity,
  HARNESS_CATALOG,
  roleExecutionSchema,
  type CommandResult,
  type Harness,
  type RoleExecution,
} from "@terminus/protocol"
import {
  harnessOutcome,
  harnessSessionId,
  harnessToolCounts,
  opencodeConfig,
  opencodeEnvironment,
  opencodeRunCommand,
  repositoryContentPolicy,
  type HarnessAgent,
} from "./opencode"

export function executionConfig(
  model: string,
  harness: Harness = "opencode"
): RoleExecution {
  const entry = catalogModel(model)
  return roleExecutionSchema.parse({
    harness,
    model,
    provider: entry.provider,
    version: HARNESS_CATALOG.find((item) => item.id === harness)!.version,
  })
}

export function agentProvenance(config: RoleExecution) {
  const resolved = executionConfig(config.model, config.harness)
  if (config.version && config.version !== resolved.version)
    throw new Error(
      "The frozen harness version is not installed in this Sandbox image"
    )
  if (config.provider && config.provider !== resolved.provider)
    throw new Error("The frozen model provider differs from the catalog")
  return {
    harness: harnessIdentity(resolved.harness),
    model: resolved.model,
    provider: resolved.provider!,
    harnessVersion: resolved.version!,
  }
}

export interface HarnessInvocation {
  command: string[]
  env: Record<string, string>
  files: Record<string, string>
}

export function harnessVersionCommand(harness: Harness): string[] {
  return [harness === "claude-code" ? "claude" : harness, "--version"]
}

export function installedHarnessVersion(
  harness: Harness,
  output: CommandResult
): string {
  const expected = HARNESS_CATALOG.find(
    (entry) => entry.id === harness
  )!.version
  const actual = output.stdout.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0]
  if (output.exitCode !== 0 || output.outputTruncated || actual !== expected)
    throw new Error(
      `Installed ${harness} version does not match the frozen Sandbox image version`
    )
  return actual
}

/** Trusted files live outside the checkout. No real credential is configured here. */
export function harnessInvocation(
  config: RoleExecution,
  agent: HarnessAgent,
  gateway: { accountId: string; gatewayId: string },
  directory: string,
  message: string,
  session?: string
): HarnessInvocation {
  agentProvenance(config)
  const entry = catalogModel(config.model)
  const root = "/workspace/harness-state"
  const system = `${agent.system}\n\n${repositoryContentPolicy}`
  const base = `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/${entry.provider}`
  if (config.harness === "opencode")
    return {
      command: opencodeRunCommand(agent.name, config.model, message, session),
      env: { ...opencodeEnvironment },
      files: {
        [opencodeEnvironment.OPENCODE_CONFIG]: opencodeConfig(
          gateway.accountId,
          gateway.gatewayId,
          config.model,
          agent
        ),
      },
    }
  if (config.harness === "claude-code") {
    const tools =
      agent.capability === "planning"
        ? "Read,Glob,Grep"
        : agent.capability === "review"
          ? "Read,Glob,Grep,Bash"
          : "Read,Glob,Grep,Bash,Edit,Write"
    return {
      command: [
        "claude",
        "--bare",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        entry.apiModel,
        "--system-prompt-file",
        `${root}/system.txt`,
        "--settings",
        `${root}/claude-settings.json`,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        `${root}/mcp.json`,
        "--permission-mode",
        "dontAsk",
        "--disable-slash-commands",
        "--tools",
        tools,
        "--allowedTools",
        tools.replace(
          "Edit,Write",
          `Edit(/${directory}/**),Write(/${directory}/**)`
        ),
        "--disallowedTools",
        "mcp__*,WebFetch,WebSearch,Skill,Agent",
        ...(session ? ["--resume", session] : []),
        "--",
        message,
      ],
      env: {
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: "provided-by-worker",
        CLAUDE_CONFIG_DIR: `${root}/claude`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        IS_SANDBOX: "1",
      },
      files: {
        [`${root}/system.txt`]: system,
        [`${root}/mcp.json`]: '{"mcpServers":{}}',
        [`${root}/claude-settings.json`]: JSON.stringify({
          permissions: {
            deny: ["Read(**/.env)", "Read(**/.env.*)"],
            blockReadsOutsideWorkingDirectories: true,
            additionalDirectories:
              agent.capability === "review"
                ? ["/workspace/review", "/tmp"]
                : ["/tmp"],
          },
          disableAllHooks: true,
          sandbox: {
            enabled: agent.capability !== "planning",
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            excludedCommands: [],
            enableWeakerNestedSandbox: false,
            filesystem: {
              allowWrite:
                agent.capability === "review"
                  ? ["/workspace/review", "/tmp"]
                  : ["/tmp"],
              denyWrite: [
                root,
                ...(agent.capability === "review" ? [directory] : []),
              ],
            },
            network: {
              allowedDomains: ["registry.npmjs.org", "localhost", "127.0.0.1"],
              allowLocalBinding: true,
            },
          },
        }),
      },
    }
  }
  // Keep native filesystem sandboxing on. A CLI that cannot enforce this in
  // Cloudflare fails; never retry with the sandbox/approval bypass flags.
  const settings = {
    model_provider: "terminus",
    model: entry.apiModel,
    model_instructions_file: `${root}/system.txt`,
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    approval_policy: "never",
    default_permissions: "terminus",
    "permissions.terminus.filesystem": {
      ":root": "read",
      [directory]: ["planning", "review"].includes(agent.capability)
        ? "read"
        : "write",
      "/tmp": "write",
      ...(agent.capability === "review"
        ? { "/workspace/review": "write" }
        : {}),
    },
    "permissions.terminus.network.enabled": agent.capability !== "planning",
    web_search: "disabled",
    "features.plugins": false,
    "features.skills": false,
    "features.hooks": false,
    "features.memories": false,
    "features.multi_agent": false,
    "analytics.enabled": false,
    "otel.exporter": "none",
    "otel.metrics_exporter": "none",
    "otel.trace_exporter": "none",
    "apps._default.enabled": false,
    check_for_update_on_startup: false,
    [`projects.${JSON.stringify(directory)}.trust_level`]: "untrusted",
    "model_providers.terminus": {
      name: "Terminus AI Gateway",
      base_url: base,
      wire_api: "responses",
    },
  }
  // Each value is valid TOML via a JSON literal (objects are inline TOML tables).
  const toml = (value: unknown): string => {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return `{ ${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`)
        .join(", ")} }`
    return JSON.stringify(value)
  }
  return {
    command: [
      "codex",
      ...Object.entries(settings).flatMap(([key, value]) => [
        "--config",
        `${key}=${toml(value)}`,
      ]),
      "exec",
      ...(session ? ["resume", session] : []),
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      `${root}/last-message.txt`,
      "--",
      message,
    ],
    env: { CODEX_HOME: `${root}/codex` },
    files: {
      [`${root}/system.txt`]: system,
      "/etc/codex/requirements.toml":
        'allowed_permission_profiles = ["terminus"]\ndefault_permissions = "terminus"\nallowed_approval_policies = ["never", "untrusted"]\n',
    },
  }
}

export interface HarnessResult {
  summary: string | null
  error: string | null
  sessionId: string | null
  tools: Record<string, number>
}

export function harnessResult(
  harness: Harness,
  output: CommandResult
): HarnessResult {
  if (harness === "opencode") {
    const result = harnessOutcome(output)
    if (!result.error && result.summary === null)
      result.error = "OpenCode did not produce a final message"
    return {
      ...result,
      sessionId: harnessSessionId(output),
      tools: harnessToolCounts(output),
    }
  }
  let summary: string | null = null
  let error: string | null = null
  let sessionId: string | null = null
  let completed = false
  for (const line of output.stdout.split("\n")) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (harness === "claude-code") {
      const parsed = claudeResultSchema.safeParse(event)
      if (!parsed.success) continue
      sessionId = parsed.data.session_id ?? null
      summary = parsed.data.result ?? null
      completed = true
      if (parsed.data.is_error || parsed.data.subtype !== "success")
        error = summary ?? parsed.data.subtype
    } else {
      const parsed = codexOutcomeEventSchema.safeParse(event)
      if (!parsed.success) continue
      const e = parsed.data
      if (e.type === "thread.started") sessionId = e.thread_id
      if (e.type === "item.completed") summary = e.item.text
      if (e.type === "turn.completed") completed = true
      if (e.type === "turn.failed") error = e.error.message
      if (e.type === "error") error = e.message
    }
  }
  if (output.outputTruncated)
    error ??= "Harness output exceeded the capture limit"
  if (output.exitCode !== 0)
    error ??= `${harness} exited with ${output.exitCode}`
  if (!completed || summary === null)
    error ??= `${harness} did not produce a successful final message`
  return { summary, error, sessionId, tools: harnessToolCounts(output) }
}

/** Filter native events in the Sandbox before returning bounded output. */
export const nativeHarnessEventFilterScript = `import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
const counts = {}
for await (const line of createInterface({ input: createReadStream(process.argv[2]) })) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (e.type === "result") console.log(JSON.stringify({ type:e.type, subtype:e.subtype, is_error:e.is_error, result:e.result, session_id:e.session_id }))
  if (e.type === "thread.started") console.log(JSON.stringify({ type:e.type, thread_id:e.thread_id }))
  if (e.type === "turn.completed") console.log(JSON.stringify({ type:e.type }))
  if (e.type === "turn.failed") console.log(JSON.stringify({ type:e.type, error:{ message:e.error?.message } }))
  if (e.type === "error") console.log(JSON.stringify({ type:e.type, message:e.message }))
  if (e.type === "item.completed" && e.item?.type === "agent_message") console.log(JSON.stringify({ type:e.type, item:{ type:"agent_message", text:e.item.text } }))
  for (const item of e.message?.content ?? []) if (item.type === "tool_use") counts[item.name] = (counts[item.name] ?? 0) + 1
  if (e.type === "item.completed" && e.item?.type !== "agent_message") counts[e.item?.type] = (counts[e.item?.type] ?? 0) + 1
}
console.log(JSON.stringify({ type:"tool_counts", counts }))
`
