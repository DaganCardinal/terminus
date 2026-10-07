import { env, SELF } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { handleApplication } from "./application"

function fixture(overrides: Partial<Env> = {}) {
  const assets = { fetch: vi.fn(async () => new Response("React app")) }
  const bindings = {
    ...env,
    APP_ORIGIN: "https://terminus.test",
    PREVIEW_BASE_URL: "https://preview.example.test",
    ASSETS: assets,
    ...overrides,
  } as Env
  return { assets, bindings }
}

describe("application HTTP boundary", () => {
  it("serves the built UI and SPA fallback through the actual assets binding", async () => {
    for (const path of ["/", "/networks/demo"]) {
      const response = await SELF.fetch(`https://terminus.test${path}`, {
        headers: { accept: "text/html" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(await response.text()).toContain('<div id="root">')
    }
  })

  it("returns API errors as JSON instead of the SPA", async () => {
    const f = fixture()
    for (const path of ["/api", "/api/missing"]) {
      const response = await handleApplication(
        new Request(`https://terminus.test${path}`),
        f.bindings
      )
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
    }
    expect(f.assets.fetch).not.toHaveBeenCalled()
  })

  it("requires an exact public app origin and refuses other hostnames", async () => {
    for (const origin of [
      "",
      "no-url",
      "http://terminus.test",
      "https://terminus.test/path",
    ]) {
      const f = fixture({ APP_ORIGIN: origin })
      expect(
        (
          await handleApplication(
            new Request("https://terminus.test/"),
            f.bindings
          )
        ).status
      ).toBe(503)
      expect(f.assets.fetch).not.toHaveBeenCalled()
    }
    const f = fixture()
    expect(
      (
        await handleApplication(
          new Request("https://other.test/api/networks"),
          f.bindings
        )
      ).status
    ).toBe(404)
    expect(f.assets.fetch).not.toHaveBeenCalled()
  })

  it("keeps every preview path ahead of the app and API, including matching assets", async () => {
    const fetchTrainPreview = vi.fn(async () => new Response("preview app"))
    const getByName = vi.fn(() => ({ fetchTrainPreview }))
    const f = fixture({ SANDBOX: { getByName } as unknown as Env["SANDBOX"] })
    const hostname = `preview-${"a".repeat(24)}-${"b".repeat(24)}.preview.example.test`
    for (const path of ["/", "/assets/main.js", "/api/networks"]) {
      const response = await handleApplication(
        new Request(`https://${hostname}${path}`),
        f.bindings
      )
      expect(await response.text()).toBe("preview app")
    }
    for (const hostname of [
      "preview.example.test",
      "invalid.preview.example.test",
    ]) {
      expect(
        (
          await handleApplication(
            new Request(`https://${hostname}/api/networks`),
            f.bindings
          )
        ).status
      ).toBe(404)
    }
    expect(getByName).toHaveBeenCalledTimes(3)
    expect(f.assets.fetch).not.toHaveBeenCalled()
  })

  it("refuses browser commands from previews, opaque origins, and other sites before changing state", async () => {
    const f = fixture()
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM networks"
    ).first("count")
    for (const origin of [
      "https://preview.example.test",
      "https://other.test",
      "null",
    ]) {
      const response = await handleApplication(
        new Request("https://terminus.test/api/networks", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ name: "Unauthorized" }),
        }),
        f.bindings
      )
      expect(response.status).toBe(403)
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM networks").first(
        "count"
      )
    ).toBe(before)
    for (const site of ["cross-site", "same-site"]) {
      const response = await handleApplication(
        new Request("https://terminus.test/api/missing", {
          method: "POST",
          headers: { "sec-fetch-site": site },
        }),
        f.bindings
      )
      expect(response.status).toBe(403)
    }
  })

  it("permits app commands and CLI clients, with local Vite proxy support", async () => {
    const f = fixture()
    for (const origin of [undefined, "https://terminus.test"]) {
      const response = await handleApplication(
        new Request("https://terminus.test/api/missing", {
          method: "POST",
          headers: origin ? { origin } : {},
        }),
        f.bindings
      )
      expect(response.status).toBe(404)
    }
    const local = fixture({ APP_ORIGIN: "", PREVIEW_BASE_URL: "" })
    expect(
      (
        await handleApplication(
          new Request("http://localhost:8787/"),
          local.bindings
        )
      ).status
    ).toBe(200)
    expect(
      (
        await handleApplication(
          new Request("http://localhost:8787/api/missing", {
            method: "POST",
            headers: { origin: "http://localhost:5173" },
          }),
          local.bindings
        )
      ).status
    ).toBe(404)
    expect(
      (
        await handleApplication(
          new Request("http://localhost:8787/api/missing", {
            method: "POST",
            headers: { origin: "https://other.test" },
          }),
          local.bindings
        )
      ).status
    ).toBe(403)
  })
})
