import { describe, expect, it } from "vitest"
import { testPorts } from "../../test/fixtures"
import { createNetwork, DEMO_SOURCE_URL, networkDefaults } from "./dispatcher"

describe("new network defaults", () => {
  it("suggests the demo app in live mode until a network imports it", async () => {
    const { dispatcher } = testPorts()
    expect(await networkDefaults(dispatcher, "fake")).toEqual({})
    expect(await networkDefaults(dispatcher, "artifacts")).toEqual({
      sourceUrl: DEMO_SOURCE_URL,
    })

    // However the import spelled it, the demo app now has its network.
    await createNetwork(dispatcher, {
      name: "Demo",
      sourceUrl: "https://GitHub.com/DaganCardinal/term-demo-app/",
    })
    expect(await networkDefaults(dispatcher, "artifacts")).toEqual({})
  })
})
