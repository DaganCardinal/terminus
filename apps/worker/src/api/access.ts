import { z } from "zod"

/**
 * Defense in depth behind Worker-level Cloudflare Access. A disabled or
 * over-broad Access policy must not expose model-backed APIs, so live requests
 * also need a valid Access JWT for an allowed email. Workers with Static Assets
 * do not receive `ctx.access`, so the header is verified here.
 */
export type AccessDecision = "allowed" | "denied" | "unconfigured"

const teamPattern = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/
const keyLifetimeMs = 10 * 60_000
const unknownKeyRefreshMs = 30_000
const clockSkewSeconds = 60

const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string() })
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.string(),
})
const certsSchema = z.object({
  keys: z.array(
    z.looseObject({
      kid: z.string(),
      kty: z.literal("RSA"),
      n: z.string(),
      e: z.string(),
    })
  ),
})

let cached: {
  team: string
  fetched: number
  keys: Map<string, CryptoKey>
} | null = null

export async function verifyAccess(
  request: Request,
  env: Env,
  now = Date.now()
): Promise<AccessDecision> {
  const team = env.ACCESS_TEAM_DOMAIN
  const audiences = list(env.ACCESS_AUD)
  const emails = list(env.ACCESS_ALLOWED_EMAILS).map((email) =>
    email.toLowerCase()
  )
  if (!teamPattern.test(team) || !audiences.length || !emails.length)
    return "unconfigured"

  const token = request.headers.get("cf-access-jwt-assertion")
  const parts = token?.split(".") ?? []
  if (parts.length !== 3) return "denied"
  const [header, payload, signature] = parts as [string, string, string]
  try {
    const { kid } = headerSchema.parse(decodeJson(header))
    const key = await accessKey(team, kid, now)
    if (
      !key ||
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`)
      ))
    )
      return "denied"
    const claims = claimsSchema.parse(decodeJson(payload))
    const seconds = now / 1000
    return claims.iss === team &&
      [claims.aud].flat().some((aud) => audiences.includes(aud)) &&
      claims.exp > seconds &&
      (claims.nbf ?? 0) <= seconds + clockSkewSeconds &&
      emails.includes(claims.email.toLowerCase())
      ? "allowed"
      : "denied"
  } catch {
    // Malformed tokens and unavailable Access keys both fail closed.
    return "denied"
  }
}

async function accessKey(
  team: string,
  kid: string,
  now: number
): Promise<CryptoKey | undefined> {
  // Keys rotate; refetch on expiry, or (rate-limited) for an unknown key ID.
  if (
    !cached ||
    cached.team !== team ||
    now - cached.fetched >= keyLifetimeMs ||
    (!cached.keys.has(kid) && now - cached.fetched >= unknownKeyRefreshMs)
  ) {
    const response = await fetch(`${team}/cdn-cgi/access/certs`)
    if (!response.ok) throw new Error("Access keys are unavailable")
    const keys = new Map<string, CryptoKey>()
    for (const { kid, kty, n, e } of certsSchema.parse(await response.json())
      .keys)
      keys.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty, n, e },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"]
        )
      )
    cached = { team, fetched: now, keys }
  }
  return cached.keys.get(kid)
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(decode(part)))
}

function decode(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
