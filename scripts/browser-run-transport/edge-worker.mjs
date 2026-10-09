import { WorkerEntrypoint } from "cloudflare:workers"

// Supplementary edge-only diagnostic. It does not exercise a Sandbox and cannot
// satisfy the full transport release gate, even when all of its checks pass.
export class CandidateOutbound extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url)
    if (url.origin !== "http://candidate.terminus.test")
      return new Response("Denied", { status: 403 })
    if (url.pathname === "/state")
      return Response.json({
        request: crypto.randomUUID(),
        scope: this.ctx.props.scope,
      })
    return new Response(
      `<!doctype html><html><body><button onclick="this.textContent='Clicked'">Click me</button></body></html>`,
      { headers: { "content-type": "text/html" } }
    )
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/prove")
      return new Response("POST /prove required", { status: 404 })
    let connection
    let socket
    let stage = "scoped_entrypoint"
    try {
      const scope = crypto.randomUUID()
      const outbound = ctx.exports.CandidateOutbound({ props: { scope } })
      stage = "browser_launch"
      connection = await env.BROWSER.launch({
        keepAlive: 60000,
        guardrails: { allowedDomains: ["candidate.terminus.test"] },
        outboundByHost: { "candidate.terminus.test": outbound },
      })
      stage = "cdp_upgrade"
      const response = await connection.webSocket.fetch(
        "https://browser-binding.invalid",
        {
          headers: { Upgrade: "websocket" },
        }
      )
      socket = response.webSocket
      if (!socket) throw Error("Browser Run did not return a CDP WebSocket")
      socket.accept()
      const command = cdpCommands(socket)
      const { targetId } = await command("Target.createTarget", {
        url: "about:blank",
      })
      const { sessionId } = await command("Target.attachToTarget", {
        targetId,
        flatten: true,
      })
      stage = "private_application"
      await command(
        "Page.navigate",
        { url: "http://candidate.terminus.test" },
        sessionId
      )
      const evaluate = async (expression) => {
        const value = await command(
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        )
        if (value.exceptionDetails) throw Error("Browser evaluation failed")
        return value.result.value
      }
      for (let n = 0; n < 20; n++) {
        if (await evaluate('document.querySelector("button") !== null')) break
        await scheduler.wait(250)
      }
      if (
        (await evaluate(
          'document.querySelector("button").click();document.querySelector("button").textContent'
        )) !== "Clicked"
      )
        throw Error("Click failed")
      const first = await evaluate('fetch("/state").then(r=>r.json())')
      await scheduler.wait(2000)
      const later = await evaluate('fetch("/state").then(r=>r.json())')
      if (
        first.scope !== scope ||
        later.scope !== scope ||
        first.request === later.request
      )
        throw Error("Scoped routing did not survive subsequent requests")
      const screenshot = await command(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId
      )
      return Response.json({
        passed: true,
        sandboxVerified: false,
        click: true,
        subsequentRequests: true,
        screenshotBytes: atob(screenshot.data).length,
      })
    } catch (error) {
      return Response.json(
        {
          passed: false,
          stage,
          entrypointType: typeof ctx.exports?.CandidateOutbound,
          error: String(error.message).slice(0, 4000),
        },
        { status: 502 }
      )
    } finally {
      socket?.close()
      if (connection) await env.BROWSER.closeSession(connection.sessionId)
    }
  },
}

function cdpCommands(socket) {
  let nextId = 0
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("close", onClose)
      }
      const onClose = () => {
        cleanup()
        reject(Error("CDP socket closed"))
      }
      const onMessage = (event) => {
        const value = JSON.parse(event.data)
        if (value.id !== id) return
        cleanup()
        value.error ? reject(Error(value.error.message)) : resolve(value.result)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(Error(`CDP timed out: ${method}`))
      }, 10000)
      socket.addEventListener("message", onMessage)
      socket.addEventListener("close", onClose)
      try {
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
}
