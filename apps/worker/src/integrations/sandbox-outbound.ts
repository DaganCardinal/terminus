import {
  catalogModel,
  modelCallSchema,
  sandboxNetworkSchema,
  type SandboxNetwork,
} from "@terminus/protocol"
import { WorkerEntrypoint } from "cloudflare:workers"

/** Each Sandbox receives only the network capabilities for its one operation. */
export async function outboundRequest(
  request: Request,
  env: Pick<
    Env,
    "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID" | "AI_GATEWAY_TOKEN"
  >,
  network: SandboxNetwork,
  send: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url)
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  )
    return denied()

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
    !url.search
  ) {
    const payload = modelCallSchema.safeParse(
      await request
        .clone()
        .json()
        .catch(() => null)
    )
    if (
      !payload.success ||
      payload.data.model !== apiModel ||
      !env.AI_GATEWAY_TOKEN
    )
      return denied()
    // Hosted tools would run outside our Sandbox role restrictions.
    const body = payload.data
    if (
      Array.isArray(body.tools) &&
      body.tools.some((tool: unknown) => {
        if (!tool || typeof tool !== "object") return true
        const type = "type" in tool ? tool.type : undefined
        return provider === "openai"
          ? !["function", "custom"].includes(String(type))
          : provider === "anthropic" && type !== undefined && type !== "custom"
      })
    )
      return denied()
    const headers = cleanHeaders(request.headers)
    if (provider === "workers-ai") {
      headers.set("authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`)
      headers.set("cf-aig-gateway-id", env.AI_GATEWAY_ID)
    } else {
      headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`)
    }
    const started = Date.now()
    const requestId = crypto.randomUUID()
    console.info("Station model request started", { requestId, provider })
    try {
      const response = await send(
        new Request(request, {
          headers,
          body: JSON.stringify(
            provider === "workers-ai"
              ? { ...body, reasoning_effort: "low" }
              : body
          ),
          redirect: "manual",
        })
      )
      console.info("Station model response received", {
        requestId,
        provider,
        status: response.status,
        durationMs: Date.now() - started,
        ray: response.headers.get("cf-ray"),
      })
      if (response.status >= 300 && response.status < 400)
        return new Response("Model redirects are not permitted", {
          status: 502,
        })
      return response
    } catch (error) {
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

export class SandboxOutbound extends WorkerEntrypoint<Env, SandboxNetwork> {
  fetch(request: Request): Promise<Response> {
    return outboundRequest(
      request,
      this.env,
      sandboxNetworkSchema.parse(this.ctx.props)
    )
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
      ].includes(name)
    )
      headers.delete(name)
  }
  return headers
}
