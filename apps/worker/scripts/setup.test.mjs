import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setup } from "./setup.mjs"

const account = "a".repeat(32)
const audience = "b".repeat(64)
const team = "https://maintainer.cloudflareaccess.com"
const origin = "https://terminus.example.workers.dev"
const userToken = "eyJhbGciOiJSUzI1NiJ9.eyJ0eXBlIjoiYXBwIn0.c2lnbmF0dXJl"
const runtimeToken = "FAKE_RUNTIME_TOKEN"
const cacheRule = {
  id: "expire-cache",
  enabled: true,
  conditions: { prefix: "" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86_400 } },
}
let directory
let state
let log
let errors
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

function localConfig() {
  return JSON.parse(
    readFileSync(join(directory, "wrangler.local.jsonc"), "utf8")
  )
}
function config() {
  const local = localConfig()
  return {
    name: "terminus",
    account_id: account,
    d1_databases: [{ binding: "DB", database_name: "terminus" }],
    r2_buckets: [{ binding: "DEPENDENCY_CACHE", bucket_name: "cache" }],
    vars: {
      ACCESS_REQUIRED: "true",
      ALTERNATIVE_HARNESSES_ENABLED: "false",
      OPENCODE_EXTERNAL_PROVIDERS_ENABLED: "false",
      ...local.vars,
    },
  }
}
function patchLocal(patch) {
  const current = localConfig()
  writeFileSync(
    join(directory, "wrangler.local.jsonc"),
    JSON.stringify({
      ...current,
      ...patch,
      vars: { ...current.vars, ...patch.vars },
    })
  )
}
function output() {
  return [...log.mock.calls, ...errors.mock.calls].flat().join("\n")
}
function envelope(result) {
  return Response.json({ success: true, result })
}
function loginResponse() {
  return new Response(null, {
    status: state.edgeStatus,
    headers: { location: state.edgeLocation },
  })
}
function useTerminal() {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  })
}

vi.mock("./config.mjs", () => ({
  LOCAL_CONFIG: "wrangler.local.jsonc",
  workerPath: (file = "") => join(directory, file),
  wranglerBin: "/mock/wrangler.js",
  readConfig: () => localConfig(),
  deploymentConfig: () => config(),
}))
vi.mock("wrangler", () => ({
  experimental_patchConfig: (_file, patch) => patchLocal(patch),
}))
// Formatting is cosmetic; keep the controlled fixture JSON readable by JSON.parse.
vi.mock("prettier", () => ({
  resolveConfig: async () => ({}),
  format: async (source) => source,
}))
vi.mock("node:readline/promises", () => ({
  createInterface: () => {
    const reader = {
      open: true,
      question: vi.fn(async () => {
        if (!state.answers.length) throw new Error("Unexpected prompt")
        return state.answers.shift()
      }),
      on: vi.fn(),
      close: vi.fn(() => {
        reader.open = false
      }),
    }
    state.readers.push(reader)
    return reader
  },
}))
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  spawnSync: vi.fn((command, args) => {
    if (command === process.execPath) {
      if (args[1] === "whoami")
        return {
          stdout: JSON.stringify({ loggedIn: true, accounts: state.accounts }),
        }
      if (args[1] === "auth")
        return {
          stdout: JSON.stringify({ type: "oauth", token: state.wranglerToken }),
        }
    }
    if (command === "docker") return { status: 0 }
    if (command === "npm" && args[1] === "deploy") {
      const secretsFile = args.indexOf("--secrets-file")
      const secrets =
        secretsFile < 0
          ? {}
          : JSON.parse(readFileSync(args[secretsFile + 1], "utf8"))
      if (secretsFile >= 0)
        expect(statSync(args[secretsFile + 1]).mode & 0o777).toBe(0o600)
      state.deployments.push({
        vars: structuredClone(config().vars),
        secrets,
        secretsFile: secretsFile < 0 ? undefined : args[secretsFile + 1],
        openPrompts: state.readers.filter((reader) => reader.open).length,
        sigintListeners: process.listenerCount("SIGINT"),
      })
      state.afterDeploy()
      if (state.deployments.length === state.failOnDeploy)
        return state.interruptDeploy
          ? { status: null, signal: "SIGINT" }
          : { status: 1 }
      state.deployedVars = structuredClone(config().vars)
      for (const name of Object.keys(secrets))
        if (!state.secrets.some((entry) => entry.name === name))
          state.secrets.push({ name })
      return { status: 0 }
    }
    throw new Error(`Unexpected subprocess: ${command} ${args.join(" ")}`)
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), "terminus-setup-test-"))
  writeFileSync(
    join(directory, "wrangler.local.jsonc"),
    JSON.stringify({
      account_id: account,
      vars: {
        APP_ORIGIN: origin,
        ACCESS_TEAM_DOMAIN: team,
        ACCESS_AUD: audience,
      },
    })
  )
  state = {
    accounts: [{ id: account, name: "Test" }],
    wranglerToken: "FAKE_WRANGLER_TOKEN",
    expiredTokens: [],
    deployments: [],
    afterDeploy: () => undefined,
    failOnDeploy: 0,
    interruptDeploy: false,
    readers: [],
    answers: [],
    secrets: [
      { name: "CLOUDFLARE_RUNTIME_TOKEN" },
      { name: "ACCESS_ALLOWED_EMAILS" },
    ],
    rules: [structuredClone(cacheRule)],
    lifecycleUpdates: [],
    accountVerification: () => envelope({ status: "active" }),
    userVerification: () => envelope({ status: "active" }),
    artifactsRead: () => envelope([]),
    workersAiRead: () => envelope([]),
    deployedVars: structuredClone(config().vars),
    edgeStatus: 302,
    edgeLocation: `${team}/cdn-cgi/access/login/${new URL(origin).hostname}?kid=${audience}`,
    signedIn: () => Response.json([]),
  }
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  })
  for (const name of ["CLOUDFLARE_RUNTIME_TOKEN", "ACCESS_ALLOWED_EMAILS"])
    vi.stubEnv(name, "")
  vi.stubEnv("TERMINUS_ACCESS_TOKEN", userToken)
  log = vi.spyOn(console, "log").mockImplementation(() => {})
  errors = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = new URL(input)
      const headers = new Headers(init.headers)
      if (url.hostname === "api.cloudflare.com") {
        if (headers.get("authorization") === `Bearer ${runtimeToken}`) {
          expect(init.method ?? "GET").toBe("GET")
          if (url.pathname === `/client/v4/accounts/${account}/tokens/verify`)
            return state.accountVerification()
          if (url.pathname === "/client/v4/user/tokens/verify")
            return state.userVerification()
          if (
            url.pathname ===
            `/client/v4/accounts/${account}/artifacts/namespaces`
          ) {
            expect(url.searchParams.get("limit")).toBe("1")
            return state.artifactsRead()
          }
          if (
            url.pathname === `/client/v4/accounts/${account}/ai/models/search`
          )
            return state.workersAiRead()
          throw new Error(`Unexpected runtime token fetch: ${url}`)
        }
        const token = headers.get("authorization")?.replace(/^Bearer /, "")
        if (state.expiredTokens.includes(token))
          return Response.json(
            {
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
            },
            { status: 403 }
          )
        expect(token).toBe(state.wranglerToken)
        if (url.pathname.endsWith("/d1/database"))
          return envelope([{ name: "terminus" }])
        if (url.pathname.endsWith("/r2/buckets/cache")) return envelope({})
        if (url.pathname.endsWith("/lifecycle")) {
          if (init.method === "PUT") {
            expect(headers.get("cf-r2-data-catalog-check")).toBe("true")
            state.rules = JSON.parse(init.body).rules
            state.lifecycleUpdates.push(structuredClone(state.rules))
          }
          return envelope({ rules: state.rules })
        }
        if (url.pathname.endsWith("/secrets")) return envelope(state.secrets)
        if (url.pathname.endsWith("/settings"))
          return envelope({
            bindings: Object.entries(state.deployedVars).map(
              ([name, text]) => ({ name, text, type: "plain_text" })
            ),
          })
      }
      if (url.href === `${team}/cdn-cgi/access/certs`)
        return Response.json({ keys: [{}] })
      if (url.origin === origin) {
        expect(init.redirect).toBe("manual")
        if (headers.has("cookie")) {
          expect(url.pathname).toBe("/api/networks")
          expect(headers.get("cookie")).toBe(`CF_Authorization=${userToken}`)
          expect(headers.has("authorization")).toBe(false)
          return state.signedIn()
        }
        return loginResponse()
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (ttyDescriptor)
    Object.defineProperty(process.stdin, "isTTY", ttyDescriptor)
  else delete process.stdin.isTTY
  rmSync(directory, { recursive: true, force: true })
})

describe("setup deployment recovery", () => {
  it("deploys an existing Worker on every run, including unchanged local config", async () => {
    expect(await setup([])).toBe(0)
    expect(await setup([])).toBe(0)
    expect(state.deployments).toHaveLength(2)
    expect(output()).toContain("Terminus is live")
  })

  it("retries the saved Access configuration after the second deployment fails", async () => {
    patchLocal({ vars: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } })
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    state.answers = [team, audience]
    state.failOnDeploy = 2
    expect(await setup([])).toBe(1)
    expect(output()).not.toContain("Terminus is live")
    expect(localConfig().vars.ACCESS_AUD).toBe(audience)
    expect(state.deployedVars.ACCESS_AUD).toBe("")
    expect(await setup([])).toBe(0)
    expect(state.deployments).toHaveLength(3)
    expect(state.deployedVars.ACCESS_AUD).toBe(audience)
  })

  it("retries a failed first deploy without requiring new local changes", async () => {
    state.failOnDeploy = 1
    expect(await setup([])).toBe(1)
    expect(await setup([])).toBe(0)
    expect(state.deployments).toHaveLength(2)
  })

  it("keeps check mode read-only and detects stale deployed Access vars", async () => {
    state.deployedVars.ACCESS_AUD = "c".repeat(64)
    const before = readFileSync(join(directory, "wrangler.local.jsonc"), "utf8")
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("Deployed ACCESS_AUD differs")
    expect(output()).not.toContain("Everything is set up")
    expect(state.deployments).toHaveLength(0)
    expect(
      spawnSync.mock.calls.every(([command]) => command === process.execPath)
    ).toBe(true)
    expect(readFileSync(join(directory, "wrangler.local.jsonc"), "utf8")).toBe(
      before
    )
    expect(
      fetch.mock.calls.every(
        ([, init]) => !init.method || init.method === "GET"
      )
    ).toBe(true)
  })
})

describe("setup deployed secrets", () => {
  it.each(["CLOUDFLARE_RUNTIME_TOKEN", "ACCESS_ALLOWED_EMAILS"])(
    "reports missing deployed %s even when environment answers are supplied",
    async (name) => {
      state.secrets = state.secrets.filter((entry) => entry.name !== name)
      vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken)
      vi.stubEnv("ACCESS_ALLOWED_EMAILS", "me@example.com")
      expect(await setup(["--check"])).toBe(1)
      expect(output()).toContain(`No ${name} secret`)
      expect(output()).toContain(
        "available to deploy; --check does not install it"
      )
      expect(output()).not.toContain("Everything is set up")
      expect(output()).not.toContain(runtimeToken)
      expect(state.deployments).toHaveLength(0)
      expect(
        fetch.mock.calls.every(
          ([, init]) => !init.method || init.method === "GET"
        )
      ).toBe(true)
    }
  )

  it("reports both missing secrets without environment answers or prompts", async () => {
    state.secrets = []
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("No CLOUDFLARE_RUNTIME_TOKEN secret")
    expect(output()).toContain("No ACCESS_ALLOWED_EMAILS secret")
  })

  it("distinguishes deployed secret names from supplied values", async () => {
    vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken)
    vi.stubEnv("ACCESS_ALLOWED_EMAILS", "me@example.com")
    expect(await setup(["--check"])).toBe(0)
    expect(output()).toContain(
      "secret is deployed (value and permissions not checked)"
    )
    expect(output()).toContain(
      "does not install it or verify the deployed token's value"
    )
    expect(output()).toContain(
      "does not install it or verify the deployed allowlist's value"
    )
    expect(state.deployments).toHaveLength(0)
  })

  it("accepts the complete deployed legacy pair", async () => {
    state.secrets = [
      "ARTIFACTS_API_TOKEN",
      "AI_GATEWAY_TOKEN",
      "ACCESS_ALLOWED_EMAILS",
    ].map((name) => ({ name }))
    expect(await setup(["--check"])).toBe(0)
    expect(output()).toContain(
      "ARTIFACTS_API_TOKEN and AI_GATEWAY_TOKEN are deployed"
    )
  })

  it.each(["ARTIFACTS_API_TOKEN", "AI_GATEWAY_TOKEN"])(
    "rejects an incomplete legacy pair containing only %s",
    async (name) => {
      state.secrets = [{ name }, { name: "ACCESS_ALLOWED_EMAILS" }]
      expect(await setup(["--check"])).toBe(1)
      expect(output()).toContain("or complete older pair")
    }
  )

  it("deploys supplied secrets in normal mode", async () => {
    state.secrets = []
    vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken)
    vi.stubEnv("ACCESS_ALLOWED_EMAILS", " me@example.com, other@example.com ")
    expect(await setup([])).toBe(0)
    expect(state.deployments[0].secrets).toEqual({
      CLOUDFLARE_RUNTIME_TOKEN: runtimeToken,
      ACCESS_ALLOWED_EMAILS: "me@example.com,other@example.com",
    })
    expect(output()).not.toContain(runtimeToken)
  })
})

describe("setup supplied runtime token checks", () => {
  beforeEach(() => vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken))

  it.each([
    ["disabled", { status: "disabled" }],
    ["expired", { status: "expired" }],
    ["missing status", {}],
    ["missing result", null],
    ["unknown status", { status: "unknown" }],
    [
      "elapsed expiry",
      { status: "active", expires_on: "2000-01-01T00:00:00Z" },
    ],
    [
      "future activation",
      { status: "active", not_before: "2999-01-01T00:00:00Z" },
    ],
    ["invalid expiry", { status: "active", expires_on: "invalid" }],
  ])(
    "rejects %s despite a successful verification envelope",
    async (_name, details) => {
      state.accountVerification = () => envelope(details)
      expect(await setup(["--check"])).toBe(1)
      expect(output()).toContain("That token isn't valid or active")
      expect(
        fetch.mock.calls.some(
          ([url]) => new URL(url).pathname === "/client/v4/user/tokens/verify"
        )
      ).toBe(false)
      expect(
        fetch.mock.calls.some(([url]) =>
          new URL(url).pathname.includes("/artifacts/")
        )
      ).toBe(false)
    }
  )

  it("accepts an active account token within its validity period", async () => {
    state.accountVerification = () =>
      envelope({
        status: "active",
        not_before: "2000-01-01T00:00:00Z",
        expires_on: "2999-01-01T00:00:00Z",
      })
    expect(await setup(["--check"])).toBe(0)
    expect(output()).toContain("Artifacts and Workers AI read probes passed")
    expect(output()).toContain("Not verified: Artifacts Edit")
    expect(output()).not.toContain("Not verified: AI Gateway Run")
    expect(output()).toContain(
      "do not test repository writes or model execution"
    )
    expect(
      fetch.mock.calls.every(
        ([, init]) => !init.method || init.method === "GET"
      )
    ).toBe(true)
  })

  it("falls back to user-token verification when the account-token endpoint fails", async () => {
    state.accountVerification = () =>
      Response.json({ success: false }, { status: 403 })
    expect(await setup(["--check"])).toBe(0)
    expect(
      fetch.mock.calls.some(
        ([url]) => new URL(url).pathname === "/client/v4/user/tokens/verify"
      )
    ).toBe(true)
  })

  it.each(["disabled", "expired"])(
    "rejects a %s user token",
    async (status) => {
      state.accountVerification = () =>
        Response.json({ success: false }, { status: 403 })
      state.userVerification = () => envelope({ status })
      expect(await setup(["--check"])).toBe(1)
      expect(output()).toContain("That token isn't valid or active")
    }
  )

  it.each(["artifactsRead", "workersAiRead"])(
    "rejects a failed %s probe",
    async (probe) => {
      state[probe] = () => Response.json({ success: false }, { status: 403 })
      expect(await setup(["--check"])).toBe(1)
      expect(output()).not.toContain("read probes passed")
      expect(output()).not.toContain("Everything is set up")
    }
  )

  it.each([
    "ALTERNATIVE_HARNESSES_ENABLED",
    "OPENCODE_EXTERNAL_PROVIDERS_ENABLED",
  ])(
    "explicitly reports unverified Gateway Run when %s enables external providers",
    async (flag) => {
      patchLocal({ vars: { [flag]: "true" } })
      state.deployedVars = structuredClone(config().vars)
      expect(await setup(["--check"])).toBe(0)
      expect(output()).toContain("Not verified: AI Gateway Run")
      expect(
        fetch.mock.calls.every(
          ([url]) => new URL(url).hostname !== "gateway.ai.cloudflare.com"
        )
      ).toBe(true)
    }
  )

  it("uses the same token checks for local setup", async () => {
    expect(await setup(["--local"])).toBe(0)
    expect(readFileSync(join(directory, ".dev.vars"), "utf8")).toBe(
      `CLOUDFLARE_RUNTIME_TOKEN=${runtimeToken}\n`
    )
    expect(statSync(join(directory, ".dev.vars")).mode & 0o777).toBe(0o600)
    expect(output()).toContain("Not verified: Artifacts Edit")
    expect(output()).not.toContain(runtimeToken)
    expect(state.deployments).toHaveLength(0)
  })
})

describe("setup dependency-cache retention", () => {
  const invalidRules = [
    ["disabled", { ...cacheRule, enabled: false }],
    ["unrelated prefix", { ...cacheRule, conditions: { prefix: "other/" } }],
    [
      "partial cache coverage",
      { ...cacheRule, conditions: { prefix: "npm/v1/some-key" } },
    ],
    ["missing prefix", { ...cacheRule, conditions: {} }],
    ["missing condition", { ...cacheRule, deleteObjectsTransition: {} }],
    [
      "longer age",
      {
        ...cacheRule,
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 31 * 86_400 },
        },
      },
    ],
    [
      "shorter age",
      {
        ...cacheRule,
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 29 * 86_400 },
        },
      },
    ],
    [
      "fixed date",
      {
        ...cacheRule,
        deleteObjectsTransition: {
          condition: { type: "Date", date: "2999-01-01T00:00:00Z" },
        },
      },
    ],
  ]

  it.each(invalidRules)(
    "reports a %s rule in read-only check mode",
    async (_name, rule) => {
      state.rules = [structuredClone(rule)]
      expect(await setup(["--check"])).toBe(1)
      expect(output()).toContain("has no enabled 30-day expiry covering npm/")
      expect(output()).not.toContain("Everything is set up")
      expect(state.rules).toEqual([rule])
      expect(state.lifecycleUpdates).toHaveLength(0)
    }
  )

  it.each(invalidRules)(
    "repairs the owned %s rule without duplicates or losing unrelated rules",
    async (_name, rule) => {
      const unrelated = {
        ...structuredClone(cacheRule),
        id: "other-expiry",
        conditions: { prefix: "other/" },
      }
      state.rules = [unrelated, structuredClone(rule)]
      expect(await setup([])).toBe(0)
      expect(state.rules).toEqual([unrelated, cacheRule])
      expect(state.lifecycleUpdates).toHaveLength(1)
      expect(await setup([])).toBe(0)
      expect(state.lifecycleUpdates).toHaveLength(1)
    }
  )

  it("adds a rule to an empty bucket policy", async () => {
    state.rules = []
    expect(await setup([])).toBe(0)
    expect(state.rules).toEqual([cacheRule])
  })

  it("preserves unrelated rules when adding the cache policy", async () => {
    const unrelated = {
      ...structuredClone(cacheRule),
      id: "other-expiry",
      conditions: { prefix: "other/" },
    }
    state.rules = [unrelated]
    expect(await setup([])).toBe(0)
    expect(state.rules).toEqual([unrelated, cacheRule])
  })

  it.each(["", "npm/"])(
    "accepts an enabled 30-day policy with prefix %j",
    async (prefix) => {
      state.rules = [
        {
          ...structuredClone(cacheRule),
          id: "existing-policy",
          conditions: { prefix },
        },
      ]
      expect(await setup(["--check"])).toBe(0)
      expect(await setup([])).toBe(0)
      expect(state.lifecycleUpdates).toHaveLength(0)
    }
  )
})

describe("setup Access verification", () => {
  it.each([
    ["arbitrary 401", 401, `${team}/cdn-cgi/access/login/?kid=${audience}`],
    [
      "non-redirect response",
      200,
      `${team}/cdn-cgi/access/login/?kid=${audience}`,
    ],
    [
      "different team",
      302,
      `https://other.cloudflareaccess.com/cdn-cgi/access/login/?kid=${audience}`,
    ],
    [
      "wrong audience",
      302,
      `${team}/cdn-cgi/access/login/?kid=${"c".repeat(64)}`,
    ],
    ["unrelated page", 302, `${team}/other?kid=${audience}`],
    [
      "HTTP login",
      302,
      `http://maintainer.cloudflareaccess.com/cdn-cgi/access/login/?kid=${audience}`,
    ],
    ["malformed Location", 302, "https://[invalid"],
  ])(
    "rejects %s before sending any user credentials",
    async (_name, status, location) => {
      state.edgeStatus = status
      state.edgeLocation = location
      expect(await setup(["--check"])).toBe(1)
      expect(output()).not.toContain("Everything is set up")
      expect(
        fetch.mock.calls.every(
          ([, init]) => !new Headers(init.headers).has("cookie")
        )
      ).toBe(true)
    }
  )

  it("requires the authenticated API check even when a login redirect omits kid", async () => {
    state.edgeLocation = `${team}/cdn-cgi/access/login/${new URL(origin).hostname}`
    state.signedIn = () => new Response("Denied", { status: 403 })
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("Signed-in /api/networks answered HTTP 403")
  })

  it.each([302, 401, 403, 503])("rejects signed-in HTTP %i", async (status) => {
    state.signedIn = () =>
      new Response(null, {
        status,
        headers: { location: "https://elsewhere.test" },
      })
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain(
      `Signed-in /api/networks answered HTTP ${status}`
    )
    expect(output()).not.toContain("Everything is set up")
  })

  it.each([
    [
      "HTML login page",
      () =>
        new Response("<html>Sign in</html>", {
          headers: { "content-type": "text/html" },
        }),
    ],
    ["JSON error", () => Response.json({ error: "Denied" })],
    [
      "malformed JSON",
      () =>
        new Response("[", { headers: { "content-type": "application/json" } }),
    ],
  ])("rejects a signed-in 200 with %s", async (_name, response) => {
    state.signedIn = response
    expect(await setup(["--check"])).toBe(1)
    expect(output()).not.toContain("Everything is set up")
  })

  it("reports missing user verification as pending in check mode", async () => {
    vi.stubEnv("TERMINUS_ACCESS_TOKEN", "")
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("Signed-in verification is pending")
    expect(output()).not.toContain("Everything is set up")
  })

  it("does not declare a deployment live when signed-in verification is pending", async () => {
    vi.stubEnv("TERMINUS_ACCESS_TOKEN", "")
    expect(await setup([])).toBe(1)
    expect(state.deployments).toHaveLength(1)
    expect(output()).toContain("Signed-in verification is pending")
    expect(output()).not.toContain("Terminus is live")
  })

  it("does not expose credentials in reflected errors or transport failures", async () => {
    for (const response of [
      () => Response.json({ error: userToken }, { status: 403 }),
      () => {
        throw new Error(userToken)
      },
    ]) {
      state.signedIn = response
      expect(await setup(["--check"])).toBe(1)
      expect(output()).not.toContain(userToken)
      expect(output()).not.toContain("Everything is set up")
    }
  })

  it("refuses a malformed token before sending credentials", async () => {
    vi.stubEnv("TERMINUS_ACCESS_TOKEN", "not-a-user-jwt")
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("Enter a user Access JWT")
    expect(
      fetch.mock.calls.every(
        ([, init]) => !new Headers(init.headers).has("cookie")
      )
    ).toBe(true)
  })

  it("supports multiple configured audiences", async () => {
    patchLocal({ vars: { ACCESS_AUD: `${"c".repeat(64)}, ${audience}` } })
    state.deployedVars = structuredClone(config().vars)
    expect(await setup(["--check"])).toBe(0)
  })

  it("only succeeds after the signed-in API returns a network list", async () => {
    expect(await setup(["--check"])).toBe(0)
    expect(output()).toContain(
      "An allowed user's session reaches /api/networks successfully"
    )
    expect(output()).toContain("Everything is set up")
    expect(state.deployments).toHaveLength(0)
  })

  it("does not log, persist or deploy the user Access token", async () => {
    vi.stubEnv("ACCESS_ALLOWED_EMAILS", "me@example.com")
    expect(await setup([])).toBe(0)
    expect(output()).not.toContain(userToken)
    expect(JSON.stringify(state.deployments)).not.toContain(userToken)
    for (const file of readdirSync(directory))
      expect(readFileSync(join(directory, file), "utf8")).not.toContain(
        userToken
      )
    expect(
      fetch.mock.calls.filter(([, init]) =>
        new Headers(init.headers).has("cookie")
      )
    ).toHaveLength(1)
  })

  it("refuses live setup with Access disabled", async () => {
    patchLocal({ vars: { ACCESS_REQUIRED: "false" } })
    expect(await setup([])).toBe(1)
    expect(state.deployments).toHaveLength(0)
    expect(output()).toContain("Live setup requires ACCESS_REQUIRED=true")
  })

  it.each([
    "http://terminus.example.workers.dev",
    "https://user:password@terminus.example.workers.dev",
    `${origin}/path`,
    "https://localhost",
  ])(
    "refuses unsafe app URL %s before deploying or sending credentials",
    async (url) => {
      patchLocal({ vars: { APP_ORIGIN: url } })
      expect(await setup([])).toBe(1)
      expect(state.deployments).toHaveLength(0)
      expect(output()).not.toContain(userToken)
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})

describe("setup Wrangler sign-in", () => {
  const tokenReads = () =>
    spawnSync.mock.calls.filter(([, args]) => args?.[1] === "auth").length

  it("renews Wrangler's token when a deploy outlasts it", async () => {
    state.afterDeploy = () => {
      state.expiredTokens.push(state.wranglerToken)
      state.wranglerToken = "RENEWED_WRANGLER_TOKEN"
    }
    expect(await setup([])).toBe(0)
    expect(tokenReads()).toBe(2)
    expect(output()).toContain("Terminus is live")
  })

  it("reports a refusal without retrying when Wrangler's token is unchanged", async () => {
    state.expiredTokens = [state.wranglerToken]
    expect(await setup([])).toBe(1)
    expect(output()).toContain(
      "Couldn't list D1 databases: Authentication error"
    )
    expect(
      fetch.mock.calls.filter(([url]) =>
        new URL(url).pathname.endsWith("/d1/database")
      )
    ).toHaveLength(1)
    expect(state.deployments).toHaveLength(0)
  })
})

describe("setup terminal handling", () => {
  it("closes prompts while commands run in the terminal, then reopens them", async () => {
    useTerminal()
    patchLocal({ vars: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } })
    vi.stubEnv("TERMINUS_ACCESS_TOKEN", "")
    state.answers = [team, audience, userToken]
    const listeners = process.listenerCount("SIGINT")
    expect(await setup([])).toBe(0)
    expect(state.deployments).toHaveLength(2)
    for (const deployment of state.deployments) {
      expect(deployment.openPrompts).toBe(0)
      expect(deployment.sigintListeners).toBe(listeners + 1)
    }
    // The Access prompts precede the second deploy; the signed-in one follows.
    expect(state.readers).toHaveLength(2)
    expect(state.readers.every((reader) => !reader.open)).toBe(true)
    expect(process.listenerCount("SIGINT")).toBe(listeners)
  })

  it("removes the secrets file when a deploy is interrupted", async () => {
    state.secrets = []
    vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken)
    vi.stubEnv("ACCESS_ALLOWED_EMAILS", "me@example.com")
    state.failOnDeploy = 1
    state.interruptDeploy = true
    expect(await setup([])).toBe(1)
    expect(output()).toContain("Deploying was interrupted")
    expect(state.deployments[0].secretsFile).toBeDefined()
    expect(existsSync(state.deployments[0].secretsFile)).toBe(false)
  })
})

describe("setup without a terminal", () => {
  it.each([
    [
      "an account choice",
      () => {
        state.accounts.push({ id: "c".repeat(32), name: "Other" })
        patchLocal({ account_id: "" })
        vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "")
      },
      "set account_id in apps/worker/wrangler.local.jsonc or CLOUDFLARE_ACCOUNT_ID",
    ],
    [
      "the runtime token",
      () => (state.secrets = [{ name: "ACCESS_ALLOWED_EMAILS" }]),
      "set CLOUDFLARE_RUNTIME_TOKEN",
    ],
    [
      "the allowed emails",
      () => (state.secrets = [{ name: "CLOUDFLARE_RUNTIME_TOKEN" }]),
      "set ACCESS_ALLOWED_EMAILS",
    ],
    [
      "the Access application",
      () => patchLocal({ vars: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } }),
      "set ACCESS_TEAM_DOMAIN and ACCESS_AUD in apps/worker/wrangler.local.jsonc",
    ],
  ])("names what answers %s", async (_name, arrange, remedy) => {
    arrange()
    expect(await setup([])).toBe(1)
    expect(output()).toContain(`run it in a terminal, or ${remedy}.`)
  })
})

describe("setup Access audience case", () => {
  it("saves a prompted audience in lowercase", async () => {
    useTerminal()
    patchLocal({ vars: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } })
    state.answers = [team, audience.toUpperCase()]
    expect(await setup([])).toBe(0)
    expect(localConfig().vars.ACCESS_AUD).toBe(audience)
    expect(state.deployedVars.ACCESS_AUD).toBe(audience)
  })

  it("reports a configured uppercase audience, which the Worker would refuse", async () => {
    patchLocal({ vars: { ACCESS_AUD: audience.toUpperCase() } })
    state.deployedVars = structuredClone(config().vars)
    expect(await setup(["--check"])).toBe(1)
    expect(output()).toContain("lowercase 64-character hex tags")
    expect(output()).not.toContain("Everything is set up")
    expect(
      fetch.mock.calls.every(
        ([, init]) => !new Headers(init.headers).has("cookie")
      )
    ).toBe(true)
  })
})

describe("setup local development", () => {
  it("summarizes a local check", async () => {
    writeFileSync(join(directory, ".dev.vars"), "")
    expect(await setup(["--local", "--check"])).toBe(0)
    expect(output()).toContain("Everything is set up.")
  })

  it("names the local setup command when a local check finds problems", async () => {
    expect(await setup(["--local", "--check"])).toBe(1)
    expect(output()).toContain("No apps/worker/.dev.vars")
    expect(output()).toContain(
      "1 thing to set up: run `npm run setup -- --local`."
    )
  })

  it("leaves a .dev.vars link alone even when its target is missing", async () => {
    const target = join(directory, "mounted-secrets")
    symlinkSync(target, join(directory, ".dev.vars"))
    vi.stubEnv("CLOUDFLARE_RUNTIME_TOKEN", runtimeToken)
    expect(await setup(["--local"])).toBe(0)
    expect(output()).toContain(".dev.vars exists (left unchanged)")
    expect(existsSync(target)).toBe(false)
  })
})

describe("setup entry point", () => {
  it.each([
    ["directly", false],
    ["through a symlink", true],
  ])(
    "runs when executed %s",
    async (_name, linked) => {
      const { spawnSync: run } = await vi.importActual("node:child_process")
      let script = fileURLToPath(new URL("./setup.mjs", import.meta.url))
      if (linked) {
        symlinkSync(script, join(directory, "setup.mjs"))
        script = join(directory, "setup.mjs")
      }
      const { status, stderr } = run(process.execPath, [script, "--unknown"], {
        encoding: "utf8",
      })
      expect(stderr).toContain("Unknown option --unknown")
      expect(status).toBe(2)
    },
    30_000
  )
})
