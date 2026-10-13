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

  it("lands old Settings bookmarks on the page for their scope", () => {
    expect(parseRoute("#/settings")).toEqual({ page: "networks" })
    expect(parseRoute("#/settings/sandboxes")).toEqual({ page: "networks" })
    expect(parseRoute("#/networks/network%201/settings")).toEqual({
      page: "overview",
      networkId: "network 1",
      view: null,
    })
    expect(parseRoute("#/networks/n/settings/sandboxes")).toEqual({
      page: "overview",
      networkId: "n",
      view: null,
    })
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
