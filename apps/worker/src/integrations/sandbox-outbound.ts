import {
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
    | "AI_GATEWAY_ACCOUNT_ID"
    | "AI_GATEWAY_ID"
    | "AI_GATEWAY_TOKEN"
    | "STATION_AGENT_MODEL"
  >,
  network: SandboxNetwork,
  send: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== "https:" || (url.port && url.port !== "443"))
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
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${grant.token}`)
    return send(new Request(request, { headers, redirect: "manual" }))
  }

  const modelPath = `/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1/chat/completions`
  if (
    network.allowModel &&
    url.hostname === "api.cloudflare.com" &&
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
      payload.data.model !== env.STATION_AGENT_MODEL ||
      !env.AI_GATEWAY_TOKEN
    )
      return denied()
    const headers = new Headers(request.headers)
    headers.delete("x-api-key")
    headers.set("authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`)
    headers.delete("cf-aig-authorization")
    headers.set("cf-aig-gateway-id", env.AI_GATEWAY_ID)
    headers.delete("content-length")
    return send(
      new Request(request, {
        headers,
        body: JSON.stringify({ ...payload.data, reasoning_effort: "low" }),
        redirect: "manual",
      })
    )
  }

  // The demo uses npm packages; other network access requires explicit configuration.
  if (
    url.hostname === "registry.npmjs.org" &&
    ["GET", "HEAD"].includes(request.method)
  ) {
    const headers = new Headers(request.headers)
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
