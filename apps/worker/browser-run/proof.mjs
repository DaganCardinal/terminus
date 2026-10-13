// The Browser Run transport proof client. It runs inside the Sandbox and
// reaches Browser Run only through the Sandbox's outbound interception.
// Every stage runs even if an earlier one fails, so a failure is localized.
import { chromium } from "playwright-core"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"

const control = "wss://browser.terminus.test"
const candidate = "http://candidate.terminus.test"

const results = []
async function stage(name, run) {
  try {
    results.push({ name, passed: true, ...(await run()) })
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: String(error?.message ?? error).slice(0, 4000),
    })
  }
}

// A WebSocket through outbound interception to the Sandbox's own Durable
// Object, with no Browser Run involved.
await stage("sandbox_websocket_interception", async () => {
  const socket = new WebSocket(`${control}/echo`)
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
        // Node's WebSocket error events often carry no message.
        reject(Error(event.error?.message || "Echo connection failed"))
      }
    })
  } finally {
    socket.close()
  }
})

// CDP to a Browser Run session without the private candidate route.
await stage("remote_browser_cdp", async () => {
  const browser = await chromium.connectOverCDP(`${control}/unrouted`, {
    timeout: 15000,
  })
  try {
    const page = await browser.contexts()[0].newPage()
    await page.goto("about:blank")
    return { version: browser.version() }
  } finally {
    await browser.close()
  }
})

// The release requirement: the remote browser loads the Sandbox's private
// application, clicks, makes later requests on the same connection, and
// captures a screenshot.
await stage("private_application", async () => {
  const browser = await chromium.connectOverCDP(`${control}/cdp`, {
    timeout: 15000,
  })
  try {
    const page = await browser.contexts()[0].newPage()
    await page.goto(candidate, { waitUntil: "networkidle" })
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
      first.scope !== process.env.PROOF_SCOPE ||
      later.scope !== process.env.PROOF_SCOPE
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
const passed = results.every((r) => r.passed)
console.log(JSON.stringify({ passed, results }))
process.exitCode = passed ? 0 : 1
