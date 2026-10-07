import { routeTrainPreview } from "../integrations/train-preview"
import { handleApi } from "./router"

/** HTTP routing only. Cloudflare Access owns authentication for the private beta. */
export async function handleApplication(
  request: Request,
  env: Env
): Promise<Response> {
  const preview = await routeTrainPreview(request, env)
  if (preview) return preview

  const url = new URL(request.url)
  const local = isLocal(url)
  if (!local) {
    let origin: URL
    try {
      origin = new URL(env.APP_ORIGIN)
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error("Invalid app origin")
    } catch {
      return rejected(503, "Configure APP_ORIGIN before serving the live app")
    }
    if (url.origin !== origin.origin)
      return new Response("Not found", { status: 404 })
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("origin")
      // Browser mutations must come from this app, never an application preview.
      // Local Vite and Wrangler may use separate ports. CLI clients have no Origin.
      if (origin && origin !== url.origin) {
        let localOrigin = false
        try {
          const parsed = new URL(origin)
          localOrigin =
            local && isLocal(parsed) && parsed.protocol === url.protocol
        } catch {
          // Opaque or malformed origins are refused.
        }
        if (!localOrigin)
          return rejected(403, "Cross-origin commands are refused")
      }
      if (
        !origin &&
        ["cross-site", "same-site"].includes(
          request.headers.get("sec-fetch-site") ?? ""
        )
      )
        return rejected(403, "Cross-origin commands are refused")
    }
    return handleApi(request, env)
  }
  return env.ASSETS.fetch(request)
}

function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

function rejected(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } }
  )
}
