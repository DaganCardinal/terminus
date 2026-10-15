import {
  catalogModel,
  errorKind,
  utilityModel,
  modelCallSchema,
  perf,
  sandboxNetworkSchema,
  type SandboxNetwork,
} from "@terminus/protocol"
import { planToolServer, proposalAsText } from "@terminus/agent-runtime"
import { WorkerEntrypoint } from "cloudflare:workers"
import {
  browserControlHost,
  browserControlRequest,
  browserSandboxSchema,
  type BrowserSandbox,
} from "./browser-run"
import { DispatchDraftStore } from "./dispatch-draft-store"
import { planToolResponse } from "./plan-tools"

/** Each Sandbox receives only the network capabilities for its one operation. */
export async function outboundRequest(
  request: Request,
  env: Pick<
    Env,
    "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID" | "AI_GATEWAY_TOKEN" | "DB"
  >,
  network: SandboxNetwork,
  send: typeof fetch = fetch,
  hedgeAfterMs: number = modelHedgeAfterMs
): Promise<Response> {
  const url = new URL(request.url)
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  )
    return denied()

  if (
    network.proposalCheck &&
    `${url.origin}${url.pathname}` === planToolServer.url &&
    !url.search
  )
    return planToolResponse(
      request,
      network.proposalCheck,
      proposalAsText(network.model ?? ""),
      new DispatchDraftStore(env.DB)
    )

  for (const grant of network.repositories) {
    const remote = new URL(grant.remote)
    if (
      !remote.hostname.endsWith(".artifacts.cloudflare.net") ||
      remote.username ||
      remote.password
    )
      return denied()
    const base = remote.pathname.replace(/\/$/, "")
    if (url.origin !== remote.origin) continue
    const route = url.pathname.slice(base.length)
    if (!url.pathname.startsWith(`${base}/`)) continue
    const discovery =
      route === "/info/refs" &&
      request.method === "GET" &&
      [
        "git-upload-pack",
        ...(grant.scope === "write" ? ["git-receive-pack"] : []),
      ].includes(url.searchParams.get("service") ?? "")
    const rpc =
      request.method === "POST" &&
      (route === "/git-upload-pack" ||
        (grant.scope === "write" && route === "/git-receive-pack"))
    if (!discovery && !rpc) return denied()
    const headers = cleanHeaders(request.headers)
    headers.set("authorization", `Bearer ${grant.token}`)
    return send(new Request(request, { headers, redirect: "manual" }))
  }

  const provider = network.provider ?? "workers-ai"
  let apiModel = network.model
  if (provider !== "workers-ai") {
    try {
      const entry = catalogModel(network.model ?? "")
      if (entry.provider !== provider) return denied()
      apiModel = entry.apiModel
    } catch {
      return denied()
    }
  }
  // The harness's own housekeeping calls (such as naming its session) use the
  // role model's utility model, which shares its provider and endpoint.
  let utilityApiModel: string | undefined
  try {
    utilityApiModel = catalogModel(utilityModel(network.model ?? "")).apiModel
  } catch {
    utilityApiModel = undefined
  }
  const modelHost =
    provider === "workers-ai"
      ? "api.cloudflare.com"
      : "gateway.ai.cloudflare.com"
  const modelPath =
    provider === "workers-ai"
      ? `/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1/chat/completions`
      : `/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${provider}/${provider === "anthropic" ? "v1/messages" : "responses"}`
  if (
    network.allowModel &&
    network.model &&
    url.hostname === modelHost &&
    url.pathname === modelPath &&
    request.method === "POST" &&
    // Claude Code's SDK client always sends `?beta=true`; nothing else is allowed.
    (!url.search || (provider === "anthropic" && url.search === "?beta=true"))
  ) {
    // TEMPORARY benchmark instrumentation: when the request reached the Worker.
    const entered = Date.now()
    const payload = modelCallSchema.safeParse(
      await request
        .clone()
        .json()
        .catch(() => null)
    )
    if (
      !payload.success ||
      (payload.data.model !== apiModel &&
        payload.data.model !== utilityApiModel) ||
      !env.AI_GATEWAY_TOKEN
    )
      return denied()
    // Hosted tools would run outside our Sandbox role restrictions.
    const body = payload.data
    const hosted = (tool: unknown): boolean => {
      if (!tool || typeof tool !== "object") return true
      const type = "type" in tool ? tool.type : undefined
      // Codex groups GPT-6 tools into namespaces; check every member.
      if (provider === "openai" && type === "namespace")
        return (
          !("tools" in tool) ||
          !Array.isArray(tool.tools) ||
          tool.tools.some(hosted)
        )
      return provider === "openai"
        ? !["function", "custom"].includes(String(type))
        : provider === "anthropic" && type !== undefined && type !== "custom"
    }
    // Responses requests can also declare tools in `additional_tools` input
    // items, which Codex uses for GPT-6 models.
    const declared = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...(Array.isArray(body.input)
        ? body.input.flatMap((item: unknown) =>
            item &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "additional_tools"
              ? "tools" in item && Array.isArray(item.tools)
                ? item.tools
                : [null]
              : []
          )
        : []),
    ]
    if (declared.some(hosted)) return denied()
    const bodyMs = Date.now() - entered
    const headers = cleanHeaders(request.headers)
    if (provider === "workers-ai") {
      headers.set("authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`)
      headers.set("cf-aig-gateway-id", env.AI_GATEWAY_ID)
      // Workers AI prefix caching: faster prefill, and cached input costs less.
      if (network.sessionAffinity)
        headers.set("x-session-affinity", network.sessionAffinity)
    } else {
      headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`)
    }
    const started = Date.now()
    const requestId = crypto.randomUUID()
    console.info("Station model request started", { requestId, provider })
    // Workers AI reasoning is set here, not by the harness. The role model
    // reasons at its frozen level; a separate utility model's housekeeping,
    // and grants frozen before levels were configurable, stay low.
    const reasoning =
      body.model === apiModel ? (network.reasoning ?? "low") : "low"
    const forwarded = JSON.stringify(
      provider === "workers-ai"
        ? { ...body, reasoning_effort: reasoning }
        : body
    )
    // TEMPORARY benchmark instrumentation.
    const shape = body as Record<string, unknown>
    const messages = Array.isArray(shape.messages) ? shape.messages : []
    const request_ = {
      requestId: requestId.slice(0, 8),
      model: body.model,
      provider,
      affinity: network.sessionAffinity?.slice(0, 16),
      kb: Math.round(forwarded.length / 1024),
      messages: messages.length,
      systemKB: Math.round(
        JSON.stringify(
          messages.filter(
            (m) =>
              !!m &&
              typeof m === "object" &&
              (m as { role?: unknown }).role === "system"
          )
        ).length / 1024
      ),
      tools: Array.isArray(shape.tools) ? shape.tools.length : 0,
      maxTokens: shape.max_tokens ?? shape.max_completion_tokens,
      stream: shape.stream === true,
      // When the request reached this handler, comparable with the harness
      // step timestamps from the Sandbox. Receiving its body is the only wait
      // before it leaves the Worker: Worker clocks do not advance during CPU work.
      at: entered,
      bodyMs,
      inFlight: ++modelCallsInFlight,
    }
    try {
      const { response, hedge } = await hedgedSend(
        (copy, signal) => {
          const sent = new Headers(headers)
          // A stalled call is queued where its affinity routes it, so the
          // copy goes elsewhere and gives up only the prefix cache.
          if (copy) sent.delete("x-session-affinity")
          return send(
            new Request(request, {
              headers: sent,
              body: forwarded,
              redirect: "manual",
              signal: AbortSignal.any([request.signal, signal]),
            })
          )
        },
        provider === "workers-ai" && body.stream === true ? hedgeAfterMs : null
      )
      Object.assign(request_, hedge)
      console.info("Station model response received", {
        requestId,
        provider,
        status: response.status,
        durationMs: Date.now() - started,
        ray: response.headers.get("cf-ray"),
        ...hedge,
      })
      if (response.status >= 300 && response.status < 400) {
        modelCallsInFlight--
        perf("model.call", {
          ...request_,
          outcome: "redirect",
          status: response.status,
          headersMs: Date.now() - started,
        })
        return new Response("Model redirects are not permitted", {
          status: 502,
        })
      }
      return await timedModelResponse(response, request_, started)
    } catch (error) {
      modelCallsInFlight--
      perf("model.call", {
        ...request_,
        outcome: "error",
        error: errorKind(error),
        headersMs: Date.now() - started,
      })
      console.error("Station model request failed", {
        requestId,
        provider,
        durationMs: Date.now() - started,
        reference:
          error instanceof Error
            ? error.message.match(
                /internal error; reference = ([a-z0-9]+)/
              )?.[1]
            : undefined,
      })
      throw error
    }
  }

  // The demo uses npm packages; other network access requires explicit configuration.
  if (
    url.hostname === "registry.npmjs.org" &&
    ["GET", "HEAD"].includes(request.method)
  ) {
    const headers = cleanHeaders(request.headers)
    headers.delete("authorization")
    return send(new Request(request, { headers, redirect: "manual" }))
  }
  return denied()
}

/** The container adds its own identity when its network grants a browser. */
type SandboxOutboundProps = SandboxNetwork & {
  browserSandbox?: BrowserSandbox
  outboundSandbox?: BrowserSandbox
}

export class SandboxOutbound extends WorkerEntrypoint<
  Env,
  SandboxOutboundProps
> {
  async fetch(request: Request): Promise<Response> {
    const network = sandboxNetworkSchema.parse(this.ctx.props)
    if (
      network.allowBrowser &&
      new URL(request.url).hostname === browserControlHost
    )
      return browserControlRequest(
        request,
        this.env,
        this.ctx.props.browserSandbox
      )
    const source = this.ctx.props.outboundSandbox
      ? browserSandboxSchema.parse(this.ctx.props.outboundSandbox)
      : undefined
    if (source) {
      const namespace = this.env[source.binding]
      return namespace
        .get(namespace.idFromString(source.sandbox))
        .outbound(request)
    }
    return outboundRequest(request, this.env, network)
  }
}

function denied(): Response {
  return new Response("Destination is not available to this Sandbox", {
    status: 403,
  })
}

/** Discard caller-controlled credentials, billing, routing and gateway overrides. */
function cleanHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("cf-aig-") ||
      [
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "content-length",
        "x-session-affinity",
      ].includes(name)
    )
      headers.delete(name)
  }
  return headers
}

/**
 * How long a streamed Workers AI call may go without response headers before
 * a copy is sent. Healthy calls answer in 1–5s; stalls queue for 20s or more
 * before producing anything, so a copy costs at most its own input.
 */
export const modelHedgeAfterMs = 8_000

interface HedgeOutcome {
  /** When the copy was sent, measured from the original; null if never. */
  hedgedAtMs: number | null
  winner: "original" | "copy"
}

/**
 * Sends a model call once, and a copy if `afterMs` passes without an answer.
 * The first successful response wins and the other request is aborted. An
 * error status or failure only wins when the other has also finished, so a
 * hedge never turns a call that would have succeeded into an error, and an
 * error before the hedge fires is returned as is, never retried.
 */
function hedgedSend(
  attempt: (copy: boolean, signal: AbortSignal) => Promise<Response>,
  afterMs: number | null
): Promise<{ response: Response; hedge: HedgeOutcome | Record<never, never> }> {
  const started = Date.now()
  const controllers: AbortController[] = []
  let hedgedAtMs: number | null = null
  let pending = 0
  let settled = false
  let fallback: { response: Response; index: number } | null = null
  let failure: unknown = null
  let timer: ReturnType<typeof setTimeout> | null = null
  return new Promise((resolve, reject) => {
    const finish = (response: Response, index: number) => {
      settled = true
      if (timer !== null) clearTimeout(timer)
      controllers.forEach((controller, i) => {
        if (i !== index) controller.abort()
      })
      if (fallback && fallback.index !== index)
        void fallback.response.body?.cancel().catch(() => {})
      resolve({
        response,
        hedge:
          afterMs === null
            ? {}
            : { hedgedAtMs, winner: index === 0 ? "original" : "copy" },
      })
    }
    const send = (index: number) => {
      const controller = new AbortController()
      controllers.push(controller)
      pending++
      attempt(index > 0, controller.signal).then(
        (response) => {
          pending--
          if (settled) {
            void response.body?.cancel().catch(() => {})
            return
          }
          if (response.ok || (pending === 0 && !fallback))
            return finish(response, index)
          if (!fallback) fallback = { response, index }
          else void response.body?.cancel().catch(() => {})
          if (pending === 0) finish(fallback.response, fallback.index)
        },
        (error: unknown) => {
          pending--
          if (settled) return
          failure ??= error
          if (pending > 0) return
          if (fallback) return finish(fallback.response, fallback.index)
          settled = true
          if (timer !== null) clearTimeout(timer)
          reject(failure)
        }
      )
    }
    send(0)
    if (afterMs !== null)
      timer = setTimeout(() => {
        if (settled) return
        hedgedAtMs = Date.now() - started
        send(1)
      }, afterMs)
  })
}

/** TEMPORARY benchmark instrumentation: model calls this isolate is serving. */
let modelCallsInFlight = 0

/** AI Gateway and Cloudflare response metadata, safe to log. */
function gatewayHeaders(headers: Headers): Record<string, unknown> {
  const gateway: Record<string, string> = {}
  for (const [name, value] of headers)
    if (name.startsWith("cf-aig-") && Object.keys(gateway).length < 12)
      gateway[name.slice("cf-aig-".length)] = value.slice(0, 120)
  return {
    gateway,
    ray: headers.get("cf-ray"),
    serverTiming: headers.get("server-timing")?.slice(0, 300) ?? undefined,
    // Names only, to discover what else the gateway and provider report.
    headerNames: [...headers.keys()].slice(0, 40),
  }
}

/** Long runs of word characters may be tokens or ids, so they are dropped. */
function errorSnippet(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{24,}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

/**
 * TEMPORARY benchmark instrumentation: passes the response through unchanged
 * and logs when its first and last bytes arrived, with the usage the final
 * chunk reports and the gateway's response metadata. Only token counts are
 * read from a successful body. Calls that end early (the harness stopped or
 * the stream failed) are logged too, so a stall is visible even when it never
 * finishes.
 */
async function timedModelResponse(
  response: Response,
  request: Record<string, unknown>,
  started: number
): Promise<Response> {
  const headersMs = Date.now() - started
  const metadata = gatewayHeaders(response.headers)
  const failure = response.ok
    ? {}
    : {
        errorBody: errorSnippet(
          await response
            .clone()
            .text()
            .catch(() => "")
        ),
      }
  if (!response.body) {
    modelCallsInFlight--
    perf("model.call", {
      ...request,
      ...metadata,
      ...failure,
      outcome: "complete",
      status: response.status,
      headersMs,
    })
    return response
  }
  const decoder = new TextDecoder()
  let firstChunkMs: number | null = null
  let bytes = 0
  let chunks = 0
  let tail = ""
  let logged = false
  const number = (pattern: RegExp) => {
    const matches = [...tail.matchAll(pattern)]
    const last = matches.at(-1)?.[1]
    return last === undefined ? undefined : Number(last)
  }
  const log = (outcome: "complete" | "canceled" | "stream_error") => {
    if (logged) return
    logged = true
    modelCallsInFlight--
    const totalMs = Date.now() - started
    perf("model.call", {
      ...request,
      ...metadata,
      ...failure,
      outcome,
      status: response.status,
      headersMs,
      firstChunkMs,
      totalMs,
      generateMs: firstChunkMs === null ? null : totalMs - firstChunkMs,
      responseKB: Math.round(bytes / 1024),
      chunks,
      promptTokens: number(/"prompt_tokens"\s*:\s*(\d+)/g),
      completionTokens: number(/"completion_tokens"\s*:\s*(\d+)/g),
      cachedTokens: number(/"cached_tokens"\s*:\s*(\d+)/g),
      reasoningTokens: number(/"reasoning_tokens"\s*:\s*(\d+)/g),
      finish: tail
        .match(/"finish_reason"\s*:\s*"([a-z_]+)"/g)
        ?.at(-1)
        ?.split('"')[3],
    })
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        log("stream_error")
        controller.error(error)
        return
      }
      if (next.done) {
        log("complete")
        controller.close()
        return
      }
      firstChunkMs ??= Date.now() - started
      bytes += next.value.byteLength
      chunks++
      tail = (tail + decoder.decode(next.value, { stream: true })).slice(-8192)
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      log("canceled")
      await reader.cancel(reason)
    },
  })
  return new Response(body, response)
}
