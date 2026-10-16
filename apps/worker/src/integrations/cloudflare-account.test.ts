import { describe, expect, it } from "vitest"
import { artifactsAccount, modelAccount } from "./cloudflare-account"

describe("the Cloudflare account", () => {
  it("uses one account ID and runtime token for Artifacts and models", () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_RUNTIME_TOKEN: "token",
    }
    expect(artifactsAccount(env)).toEqual({
      accountId: "account",
      apiToken: "token",
    })
    expect(modelAccount(env)).toEqual({ accountId: "account", token: "token" })
  })

  it("falls back to the older per-service names while the new ones are empty", () => {
    const legacy = {
      ARTIFACTS_ACCOUNT_ID: "artifacts-account",
      ARTIFACTS_API_TOKEN: "artifacts-token",
      AI_GATEWAY_ACCOUNT_ID: "model-account",
      AI_GATEWAY_TOKEN: "model-token",
    }
    const env = { ...legacy, CLOUDFLARE_ACCOUNT_ID: "" }
    expect(artifactsAccount(env)).toEqual({
      accountId: "artifacts-account",
      apiToken: "artifacts-token",
    })
    expect(modelAccount(env)).toEqual({
      accountId: "model-account",
      token: "model-token",
    })

    const both = {
      ...legacy,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_RUNTIME_TOKEN: "token",
    }
    expect(artifactsAccount(both)).toEqual({
      accountId: "account",
      apiToken: "token",
    })
    expect(modelAccount(both)).toEqual({ accountId: "account", token: "token" })
  })

  it("reports nothing configured as empty values", () => {
    expect(artifactsAccount({})).toEqual({ accountId: "", apiToken: "" })
    expect(modelAccount({})).toEqual({ accountId: "", token: "" })
  })
})
