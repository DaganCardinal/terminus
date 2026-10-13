import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { browserControlRequest, readBrowserRunProof } from "./browser-run"

const stages = [
  "sandbox_websocket_interception",
  "remote_browser_cdp",
  "private_application",
]

function output(results: unknown[], exitCode = 0) {
  return {
    exitCode,
    stdout: `${JSON.stringify({ passed: exitCode === 0, results })}\n`,
    stderr: "",
  }
}

describe("Browser Run proof results", () => {
  it("passes only when every stage is reported, in order, and passed", () => {
    const passed = stages.map((name) => ({ name, passed: true }))
    expect(readBrowserRunProof("s", 10, output(passed))).toMatchObject({
      passed: true,
      sandbox: "s",
      stages: passed,
    })
    expect(
      readBrowserRunProof("s", 10, output(passed.slice(0, 2))).passed
    ).toBe(false)
    expect(
      readBrowserRunProof(
        "s",
        10,
        output([...passed.slice(0, 2), { name: stages[2], passed: false }], 1)
      )
    ).toMatchObject({ passed: false, exitCode: 1 })
  })

  it("reports a client that printed no report as a failure", () => {
    expect(
      readBrowserRunProof("s", 10, {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot find package 'playwright-core'",
      })
    ).toMatchObject({
      passed: false,
      stages: [],
      stderr: "Cannot find package 'playwright-core'",
    })
  })
})

describe("Browser control routing", () => {
  const enabled = { ...env, BROWSER_RUN_ENABLED: "true" }
  const owner = {
    binding: "SANDBOX_STANDARD_2",
    sandbox: env.SANDBOX_STANDARD_2.idFromName("browser-routing").toString(),
  }
  const upgrade = (url: string, init: RequestInit = {}) =>
    new Request(url, { ...init, headers: { Upgrade: "websocket" } })

  it("refuses requests while disabled, without an owner, or off its routes", async () => {
    const valid = upgrade("https://browser.terminus.test/cdp")
    for (const [request, routeEnv, sandbox] of [
      [valid, env, owner],
      [valid, enabled, undefined],
      [valid, enabled, { ...owner, binding: "SANDBOX" }],
      [upgrade("https://browser.terminus.test/other"), enabled, owner],
      [upgrade("https://browser.terminus.test/cdp?x=1"), enabled, owner],
      [upgrade("http://browser.terminus.test/cdp"), enabled, owner],
      [new Request("https://browser.terminus.test/cdp"), enabled, owner],
    ] as const) {
      const response = await browserControlRequest(request, routeEnv, sandbox)
      expect(await response.text()).toBe(
        "Destination is not available to this Sandbox"
      )
    }
  })

  it("forwards upgrades to the owning container, which checks its own grant", async () => {
    const response = await browserControlRequest(
      upgrade("https://browser.terminus.test/cdp"),
      enabled,
      owner
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("Browser Run is not available")
  })
})
