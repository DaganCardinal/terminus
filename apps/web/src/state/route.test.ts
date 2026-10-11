import { describe, expect, it } from "vitest"
import { parseRoute, routes } from "./route"

describe("routes", () => {
  it("lists networks by default", () => {
    expect(parseRoute("")).toEqual({ page: "networks" })
    expect(parseRoute("#/")).toEqual({ page: "networks" })
  })

  it("lands on a network's overview before its map", () => {
    expect(parseRoute("#/networks/network-1")).toEqual({
      page: "overview",
      networkId: "network-1",
      view: null,
    })
    expect(parseRoute("#/networks/network-1/map")).toEqual({
      page: "map",
      networkId: "network-1",
    })
  })

  it("opens General settings or one network's settings", () => {
    expect(parseRoute(routes.settings())).toEqual({
      page: "settings",
      networkId: null,
      section: "agents",
    })
    expect(parseRoute(routes.networkSettings("network 1"))).toEqual({
      page: "settings",
      networkId: "network 1",
      section: "agents",
    })
  })

  it("opens the Sandboxes section at either scope", () => {
    expect(routes.settings("sandboxes")).toBe("#/settings/sandboxes")
    expect(parseRoute(routes.settings("sandboxes"))).toEqual({
      page: "settings",
      networkId: null,
      section: "sandboxes",
    })
    expect(parseRoute(routes.networkSettings("n", "sandboxes"))).toEqual({
      page: "settings",
      networkId: "n",
      section: "sandboxes",
    })
    expect(parseRoute("#/settings/unknown")).toEqual({ page: "networks" })
  })

  it("round-trips document and file paths", () => {
    const path = "docs/getting started/intro.md"
    expect(parseRoute(routes.docs("n", path))).toEqual({
      page: "overview",
      networkId: "n",
      view: { kind: "docs", path },
    })
    expect(parseRoute(routes.files("n", "src/App.tsx"))).toMatchObject({
      view: { kind: "files", path: "src/App.tsx" },
    })
  })
})
