import { chromium } from "playwright-core"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"

const results = []
async function stage(name, run) {
  try {
    results.push({ name, passed: true, ...(await run()) })
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: String(error.message).slice(0, 4000),
    })
  }
}

await stage("sandbox_websocket_interception", async () => {
  const socket = new WebSocket("wss://browser.terminus.test/echo")
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Echo timed out")), 10000)
      socket.onopen = () => socket.send("sandbox-websocket-proof")
      socket.onmessage = (event) => {
        clearTimeout(timeout)
        event.data === "sandbox-websocket-proof"
          ? resolve()
          : reject(Error("Echo content differs"))
      }
      socket.onerror = (event) => {
        clearTimeout(timeout)
        reject(Error(event.error?.message ?? "Echo connection failed"))
      }
    })
  } finally {
    socket.close()
  }
})

await stage("remote_browser_cdp", async () => {
  const browser = await chromium.connectOverCDP(
    "wss://browser.terminus.test/unrouted",
    { timeout: 15000 }
  )
  try {
    const page = await browser.contexts()[0].newPage()
    await page.goto("about:blank")
    return { version: browser.version() }
  } finally {
    await browser.close()
  }
})

await stage("private_application", async () => {
  const browser = await chromium.connectOverCDP(
    "wss://browser.terminus.test/cdp",
    { timeout: 15000 }
  )
  try {
    const page = await browser.contexts()[0].newPage()
    await page.goto("http://candidate.terminus.test", {
      waitUntil: "networkidle",
    })
    await page.getByRole("button", { name: "Click me" }).click()
    if ((await page.getByRole("button").innerText()) !== "Clicked")
      throw Error("Click failed")
    const state = () =>
      page.evaluate(() => fetch("/state").then((r) => r.json()))
    const first = await state()
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const later = await state()
    if (
      later.requests <= first.requests ||
      first.scope !== process.env.PROBE_SCOPE ||
      later.scope !== process.env.PROBE_SCOPE
    )
      throw Error(
        "Private routing did not survive or reached the wrong application"
      )
    const png = await page.screenshot()
    const path = "/tmp/browser-proof.png"
    await writeFile(path, png)
    return {
      click: true,
      subsequentRequests: true,
      screenshot: {
        path,
        bytes: png.length,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    }
  } finally {
    await browser.close()
  }
})

// Only metadata leaves the container. Never print screenshot pixels.
console.log(JSON.stringify({ passed: results.every((r) => r.passed), results }))
process.exitCode = results.every((r) => r.passed) ? 0 : 1
