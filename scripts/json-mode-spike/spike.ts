/**
 * Spike: does Workers AI enforce a JSON schema (`response_format`) for the
 * Dispatcher's model, so a long proposal cannot come back malformed?
 *
 * It calls the model directly, as a constrained final call would: no tools,
 * no OpenCode, and no streaming (Workers AI JSON mode does not stream).
 *
 * Variants:
 *   openai  /ai/v1/chat/completions with OpenAI's response_format shape
 *   native  /ai/run/<model> with Workers AI's documented response_format shape
 *   none    /ai/v1/chat/completions without response_format (the control)
 *
 * Cases:
 *   copy    Return the malformed live submission (fixtures/submission-1.txt)
 *           as the answer. Copying it, GLM tends to repeat its own bracket
 *           slips; a schema-constrained decoder cannot emit them.
 *   plan    Plan docs/test-prompts Goal B with the real Dispatcher prompt,
 *           from the live run's exploration findings (fixtures/findings.json).
 *
 * Each answer is checked three ways: strict JSON.parse (no repair), a bracket
 * scan for closers that do not match their opener, and reviewProposalText,
 * exactly as the Dispatcher Workflow reviews a proposal.
 *
 * Credentials come from apps/worker/.dev.vars (the Worker's AI_GATEWAY_*
 * values). Run: node scripts/json-mode-spike/run.mjs [--case copy] [--variant
 * native] [--schema relaxed] [--repeat 3] [--model <id>] [--dry-run]
 * [--evaluate <answer file>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { PlanningContext } from "@terminus/domain"
import { dispatchProposalSubmissionSchema } from "@terminus/protocol"
import {
  dispatcherGoalMessage,
  dispatcherSystemPrompt,
  reviewProposalText,
} from "@terminus/agent-runtime"

type Variant = "openai" | "native" | "none"
type Message = { role: "system" | "user"; content: string }

const variants: Variant[] = ["openai", "native", "none"]
const network: PlanningContext = {
  validationNames: ["typecheck", "test", "build"],
  activeLines: [],
}

export async function main(spikeDir: string) {
  const root = resolve(spikeDir, "../..")
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      case: { type: "string", default: "copy,plan" },
      variant: { type: "string", default: variants.join(",") },
      schema: { type: "string", default: "full" },
      order: { type: "string", default: "schema" },
      omit: { type: "string", default: "" },
      repeat: { type: "string", default: "1" },
      concurrency: { type: "string", default: "3" },
      model: { type: "string", default: "@cf/zai-org/glm-5.3" },
      "max-tokens": { type: "string", default: "16384" },
      "dry-run": { type: "boolean", default: false },
      evaluate: { type: "string" },
    },
  })

  if (values.evaluate) {
    const content = await readFile(values.evaluate, "utf8")
    console.log(JSON.stringify(evaluate(content), null, 2))
    return
  }

  const full = z.toJSONSchema(dispatchProposalSubmissionSchema)
  // Constrained decoders often reject regex lookarounds, which the area
  // pattern uses; "relaxed" tells a rejected schema from a rejected feature.
  const relaxed = values.schema === "relaxed" ? withoutPatterns(full) : full
  // The decoder enforces property order. GLM writes `summary` first, after
  // which a schema-ordered `junctions` can no longer appear; "natural" puts
  // the top-level properties in the order the model writes them.
  const ordered =
    values.order === "natural"
      ? reordered(relaxed, [
          "summary",
          "findings",
          "junctions",
          "lines",
          "baselineFix",
        ])
      : relaxed
  // Top-level properties the decoder may not emit, such as baselineFix when
  // the baseline passed.
  const schema = omitted(
    ordered,
    list(values.omit, Object.keys(full.properties ?? {}))
  )
  const goal = await goalB(root)
  const findings = await readFile(
    join(spikeDir, "fixtures/findings.json"),
    "utf8"
  )
  const draft = await readFile(
    join(spikeDir, "fixtures/submission-1.txt"),
    "utf8"
  )
  const cases: Record<string, Message[]> = {
    copy: [
      {
        role: "system",
        content: `Answer with one JSON object that matches this schema, and nothing else.\n\n${JSON.stringify(full)}`,
      },
      {
        role: "user",
        content: `Return this planning proposal as your answer, keeping every value exactly as written:\n\n${draft}`,
      },
    ],
    plan: [
      {
        role: "system",
        content: dispatcherSystemPrompt({ network, baseline: null }),
      },
      {
        role: "user",
        content: `${dispatcherGoalMessage(goal)}\n\nThis run has no tools. Plan from the goal and these findings from an earlier exploration of the same checkout:\n${findings}`,
      },
    ],
  }

  const selectedCases = list(values.case, Object.keys(cases))
  const selectedVariants = list(values.variant, variants) as Variant[]
  const runs = selectedCases.flatMap((name) =>
    selectedVariants.flatMap((variant) =>
      Array.from({ length: Number(values.repeat) }, (_, i) => ({
        name,
        variant,
        attempt: i + 1,
      }))
    )
  )
  const settings = {
    model: values.model,
    maxTokens: Number(values["max-tokens"]),
    schema,
    schemaName: values.schema,
  }

  if (values["dry-run"]) {
    for (const run of runs) {
      const { url, body } = request(
        "<account>",
        run.variant,
        cases[run.name]!,
        settings
      )
      console.log(
        `${run.name}/${run.variant}#${run.attempt}: POST ${url} (${Math.round(JSON.stringify(body).length / 1024)} KB)`
      )
    }
    console.log(
      `schema: ${Math.round(JSON.stringify(schema).length / 1024)} KB, properties ${Object.keys(get(schema, "properties") as object).join(", ")}`
    )
    const found = await credentials(root)
    console.log(
      `credentials from ${found.source}: account ${found.account}, gateway ${found.gateway ?? "none"}, token ${found.token.length} chars`
    )
    return
  }

  const { token, account, gateway, source } = await credentials(root)
  const out = join(
    root,
    "docs/temp/json-mode-spike",
    new Date().toISOString().replace(/[:.]/g, "-")
  )
  await mkdir(out, { recursive: true })
  console.log(
    `${runs.length} calls to ${values.model}, schema ${values.schema} in ${values.order} order${values.omit ? ` without ${values.omit}` : ""}, credentials from ${source}; results in ${out}`
  )

  const results: Record<string, unknown>[] = []
  await pool(runs, Number(values.concurrency), async (run) => {
    const label = `${run.name}-${run.variant}-${run.attempt}`
    const { url, body } = request(
      account,
      run.variant,
      cases[run.name]!,
      settings
    )
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }
    if (gateway) headers["cf-aig-gateway-id"] = gateway
    console.log(`… ${label} started`)
    const started = Date.now()
    let status: number | null = null
    let raw = ""
    let failure: string | undefined
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60_000),
      })
      status = response.status
      raw = await response.text()
      if (!response.ok) failure = raw.slice(0, 1000)
    } catch (error) {
      failure =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10
    await writeFile(join(out, `${label}.response.json`), raw)
    const reply = answer(raw)
    if (reply.content !== undefined)
      await writeFile(join(out, `${label}.content.txt`), reply.content)
    const result = {
      label,
      case: run.name,
      variant: run.variant,
      status,
      seconds,
      failure,
      source: reply.source,
      finish: reply.finish,
      usage: reply.usage,
      contentChars: reply.content?.length,
      reasoningChars: reply.reasoning?.length,
      ...(reply.content === undefined ? {} : evaluate(reply.content)),
    }
    results.push(result)
    console.log(`✓ ${label} finished in ${seconds}s (HTTP ${status ?? "none"})`)
  })

  results.sort((a, b) => String(a.label).localeCompare(String(b.label)))
  await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2))
  console.table(
    results.map((r) => ({
      run: r.label,
      http: r.status,
      secs: r.seconds,
      finish: r.finish,
      chars: r.contentChars,
      strictJson: (r.strictJson as { ok: boolean } | undefined)?.ok,
      slips: r.bracketSlips,
      review:
        (r.review as { kind: string } | undefined)?.kind ??
        r.failure?.toString().slice(0, 60),
    }))
  )
  console.log(`Details: ${join(out, "summary.json")}`)
}

function request(
  account: string,
  variant: Variant,
  messages: Message[],
  settings: { model: string; maxTokens: number; schema: unknown }
): { url: string; body: Record<string, unknown> } {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai`
  // Production sends the same reasoning effort to Workers AI.
  const common = {
    messages,
    max_tokens: settings.maxTokens,
    reasoning_effort: "low",
  }
  if (variant === "native")
    return {
      url: `${base}/run/${settings.model}`,
      body: {
        ...common,
        response_format: { type: "json_schema", json_schema: settings.schema },
      },
    }
  return {
    url: `${base}/v1/chat/completions`,
    body: {
      model: settings.model,
      ...common,
      ...(variant === "openai"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "dispatch_proposal",
                schema: settings.schema,
              },
            },
          }
        : {}),
    },
  }
}

/** The answer text from either endpoint's response shape. */
function answer(raw: string): {
  source: string
  content?: string
  reasoning?: string
  finish?: unknown
  usage?: unknown
} {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { source: "unparseable response" }
  }
  const result = get(body, "result") ?? body
  const message = get(result, "choices", 0, "message")
  if (message !== undefined) {
    const content = get(message, "content")
    const reasoning =
      get(message, "reasoning_content") ?? get(message, "reasoning")
    return {
      source: "choices",
      content: typeof content === "string" ? content : undefined,
      reasoning: typeof reasoning === "string" ? reasoning : undefined,
      finish: get(result, "choices", 0, "finish_reason"),
      usage: get(result, "usage"),
    }
  }
  const response = get(result, "response")
  if (response !== undefined)
    return {
      // An object here means the endpoint parsed the JSON itself.
      source: typeof response === "string" ? "response" : "response (object)",
      content:
        typeof response === "string" ? response : JSON.stringify(response),
      usage: get(result, "usage"),
    }
  return { source: "unrecognized response" }
}

function evaluate(content: string) {
  const text = content.trim()
  let strictJson: { ok: boolean; error?: string; near?: string } = { ok: true }
  try {
    JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const at = Number(/position (\d+)/.exec(message)?.[1] ?? -1)
    strictJson = {
      ok: false,
      error: message,
      near:
        at < 0
          ? undefined
          : `${text.slice(Math.max(0, at - 80), at)}⟦${text.slice(at, at + 40)}`,
    }
  }
  const slips = bracketSlips(text)
  const review = reviewProposalText(text, network, null)
  return {
    strictJson,
    bracketSlips: slips.length,
    firstSlips: slips.slice(0, 3),
    review:
      review.kind === "valid"
        ? {
            kind: review.kind,
            lines: review.proposal.lines.length,
            junctions: review.proposal.junctions?.length ?? 0,
          }
        : review.kind === "schema"
          ? {
              kind: review.kind,
              issues: review.issues.slice(0, 5),
              parseError: review.parseError,
            }
          : { kind: review.kind, errors: review.errors.slice(0, 5) },
  }
}

/** Closers that do not match the innermost open bracket, outside strings. */
function bracketSlips(text: string) {
  const open: string[] = []
  const slips: { at: number; wrote: string; open: string; near: string }[] = []
  let inString = false
  let escaped = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === "{" || char === "[") open.push(char)
    else if (char === "}" || char === "]") {
      const top = open.pop()
      if (top !== undefined && (top === "{") !== (char === "}"))
        slips.push({
          at,
          wrote: char,
          open: top,
          near: `${text.slice(Math.max(0, at - 50), at)}⟦${text.slice(at, at + 20)}`,
        })
    }
  }
  return slips
}

/**
 * The Worker's own Workers AI credentials, so the spike authenticates exactly
 * as production does. apps/worker/.dev.vars wins over the environment, where
 * a stale token is easy to leave behind. The file may be a secrets-manager
 * pipe that blocks while the vault is locked, hence the timeout.
 */
async function credentials(root: string) {
  const file = join(root, "apps/worker/.dev.vars")
  const vars: Record<string, string> = {}
  const text = await Promise.race([
    readFile(file, "utf8").catch(() => ""),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Reading ${file} timed out; if a secrets manager provides it, unlock it and retry`
            )
          ),
        10_000
      ).unref()
    ),
  ])
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) vars[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2")
  }
  const token =
    vars.AI_GATEWAY_TOKEN ??
    process.env.CLOUDFLARE_API_TOKEN ??
    process.env.CF_API_TOKEN
  const account =
    vars.AI_GATEWAY_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !account)
    throw new Error(
      `No credentials: ${file} needs AI_GATEWAY_TOKEN and AI_GATEWAY_ACCOUNT_ID (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)`
    )
  return {
    token,
    account,
    gateway: vars.AI_GATEWAY_ID ?? process.env.AI_GATEWAY_ID,
    source: vars.AI_GATEWAY_TOKEN ? "apps/worker/.dev.vars" : "the environment",
  }
}

async function goalB(root: string): Promise<string> {
  const doc = await readFile(
    join(root, "docs/test-prompts/04-lines-then-junction.md"),
    "utf8"
  )
  const goal = /## Goal B[\s\S]*?```text\n([\s\S]*?)\n```/.exec(doc)?.[1]
  if (!goal)
    throw new Error(
      "Goal B not found in docs/test-prompts/04-lines-then-junction.md"
    )
  return goal
}

function omitted(schema: unknown, keys: string[]): unknown {
  if (!keys.length) return schema
  const properties = get(schema, "properties") as Record<string, unknown>
  const required = (get(schema, "required") as string[] | undefined) ?? []
  return {
    ...(schema as Record<string, unknown>),
    properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => !keys.includes(key))
    ),
    required: required.filter((key) => !keys.includes(key)),
  }
}

function reordered(schema: unknown, order: string[]): unknown {
  const properties = get(schema, "properties") as Record<string, unknown>
  const keys = [
    ...order.filter((key) => key in properties),
    ...Object.keys(properties).filter((key) => !order.includes(key)),
  ]
  return {
    ...(schema as Record<string, unknown>),
    properties: Object.fromEntries(keys.map((key) => [key, properties[key]])),
  }
}

function withoutPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPatterns)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "pattern" && key !== "$schema")
      .map(([key, entry]) => [key, withoutPatterns(entry)])
  )
}

function list(value: string | undefined, allowed: string[]): string[] {
  const items = (value ?? "").split(",").filter(Boolean)
  const unknown = items.filter((item) => !allowed.includes(item))
  if (unknown.length)
    throw new Error(
      `Unknown ${unknown.join(", ")}; choose from ${allowed.join(", ")}`
    )
  return items
}

function get(value: unknown, ...path: (string | number)[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

async function pool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>
) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!)
    })
  )
}
