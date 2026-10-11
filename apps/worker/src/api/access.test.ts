import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { verifyAccess } from "./access"
import { handleApplication } from "./application"

const team = "https://maintainer.cloudflareaccess.com"
const aud = "a".repeat(64)
const algorithm = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
}
const signing = (await crypto.subtle.generateKey(algorithm, true, [
  "sign",
  "verify",
])) as CryptoKeyPair
const impostor = (await crypto.subtle.generateKey(algorithm, true, [
  "sign",
  "verify",
])) as CryptoKeyPair
const publicJwk = (await crypto.subtle.exportKey(
  "jwk",
  signing.publicKey
)) as JsonWebKey

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function token(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const json = (value: unknown) =>
    encode(new TextEncoder().encode(JSON.stringify(value)))
  const unsigned = `${json({ alg: "RS256", kid: "current", ...options.header })}.${json(
    {
      iss: team,
      aud: [aud],
      email: "me@example.com",
      exp: now + 300,
      nbf: now - 5,
      ...claims,
    }
  )}`
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signing.privateKey,
    new TextEncoder().encode(unsigned)
  )
  return `${unsigned}.${encode(new Uint8Array(signature))}`
}

function configured(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    ACCESS_REQUIRED: "true",
    ACCESS_TEAM_DOMAIN: team,
    ACCESS_AUD: `other-aud, ${aud}`,
    ACCESS_ALLOWED_EMAILS: "Me@Example.com",
    ...overrides,
  } as Env
}

function request(jwt?: string, url = "https://terminus.test/api/networks") {
  return new Request(
    url,
    jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {}
  )
}

function serveKeys() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input) === `${team}/cdn-cgi/access/certs`
        ? Response.json({ keys: [{ ...publicJwk, kid: "current" }] })
        : new Response("Not found", { status: 404 })
    )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Cloudflare Access verification", () => {
  it("is unconfigured until the team, audience and allowed emails are set", async () => {
    for (const overrides of [
      { ACCESS_TEAM_DOMAIN: "" },
      { ACCESS_TEAM_DOMAIN: "maintainer.cloudflareaccess.com" },
      { ACCESS_TEAM_DOMAIN: "https://evil.example.com" },
      { ACCESS_AUD: " , " },
      { ACCESS_ALLOWED_EMAILS: undefined },
    ])
      expect(
        await verifyAccess(request(await token()), configured(overrides))
      ).toBe("unconfigured")
  })

  it("allows a valid token for an allowed email", async () => {
    serveKeys()
    expect(await verifyAccess(request(await token()), configured())).toBe(
      "allowed"
    )
    expect(
      await verifyAccess(request(await token({ aud })), configured())
    ).toBe("allowed")
  })

  it("denies missing, malformed, forged and mismatched tokens", async () => {
    serveKeys()
    const now = Math.floor(Date.now() / 1000)
    for (const jwt of [
      undefined,
      "not-a-jwt",
      `${await token()}.extra`,
      await token({}, { key: impostor.privateKey }),
      await token({}, { header: { alg: "HS256" } }),
      await token({}, { header: { kid: "unknown" } }),
      await token({ aud: ["other"] }),
      await token({ iss: "https://other.cloudflareaccess.com" }),
      await token({ exp: now - 1 }),
      await token({ nbf: now + 600 }),
      await token({ email: "someone@example.com" }),
      await token({ email: undefined }),
    ])
      expect(await verifyAccess(request(jwt), configured())).toBe("denied")
  })

  it("fails closed when Access keys cannot be fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unavailable", { status: 503 })
    )
    expect(
      await verifyAccess(
        request(await token()),
        configured({
          ACCESS_TEAM_DOMAIN: "https://unavailable.cloudflareaccess.com",
        })
      )
    ).toBe("denied")
  })
})

describe("application Access boundary", () => {
  const assets = () => ({ fetch: vi.fn(async () => new Response("React app")) })

  it("refuses live requests without verification, including previews", async () => {
    const bindings = configured({
      ASSETS: assets(),
      PREVIEW_BASE_URL: "https://preview.example.test",
    })
    for (const url of [
      "https://terminus.test/",
      "https://terminus.test/api/networks",
      `https://preview-${"a".repeat(24)}-${"b".repeat(24)}.preview.example.test/`,
    ])
      expect(
        (await handleApplication(request(undefined, url), bindings)).status
      ).toBe(403)
    expect(bindings.ASSETS.fetch).not.toHaveBeenCalled()

    const unconfigured = await handleApplication(
      request(),
      configured({ ACCESS_AUD: "" })
    )
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.headers.get("cache-control")).toBe("no-store")
  })

  it("serves verified live requests and leaves local development open", async () => {
    serveKeys()
    const bindings = configured({ ASSETS: assets() })
    expect(
      (
        await handleApplication(
          request(await token(), "https://terminus.test/"),
          bindings
        )
      ).status
    ).toBe(200)
    const fetchTrainPreview = vi.fn(async () => new Response("preview app"))
    const local = configured({
      ACCESS_AUD: "",
      ASSETS: assets(),
      PREVIEW_BASE_URL: "",
      WORKSPACE_SANDBOX: {
        getByName: () => ({ fetchTrainPreview }),
      } as unknown as Env["WORKSPACE_SANDBOX"],
    })
    for (const url of [
      "http://localhost:8787/",
      `http://preview-${"a".repeat(24)}-${"b".repeat(24)}.localhost:8787/`,
    ])
      expect(
        (await handleApplication(request(undefined, url), local)).status
      ).toBe(200)
    expect(fetchTrainPreview).toHaveBeenCalledOnce()
  })
})
