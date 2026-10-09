import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"

// Isolated, one-off development probe. This class has local storage only and is
// not imported by or deployed with the Terminus application.
export class ExecutionSandbox extends DurableObject {
  fetch(request) {
    // Use native fetch for upgrades: RPC cannot serialize WebSocket responses.
    return this.openBrowser(request)
  }

  async prove() {
    const container = this.ctx.container
    await this.ctx.storage.setAlarm(Date.now() + 90000)
    if (!container.running) container.start({ enableInternet: false })
    await container.setInactivityTimeout(60000)
    const outbound = this.ctx.exports.ProbeOutbound({
      props: { sandbox: this.ctx.id.toString() },
    })
    await container.interceptAllOutboundHttp(outbound)
    await container.interceptOutboundHttps("*", outbound)
    const scope = crypto.randomUUID()
    try {
      await container.exec(["node", "/opt/proof/app.mjs"], {
        env: { PROBE_SCOPE: scope },
        stdin: new ReadableStream({ start: (c) => c.close() }),
        stdout: "ignore",
        stderr: "ignore",
      })
      await this.waitForApplication()
      const process = await container.exec(["node", "/opt/proof/client.mjs"], {
        env: {
          NODE_EXTRA_CA_CERTS:
            "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          PROBE_SCOPE: scope,
        },
        stdin: new ReadableStream({ start: (c) => c.close() }),
        signal: AbortSignal.timeout(60000),
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        capture(process.stdout),
        capture(process.stderr),
        process.exitCode,
      ])
      return { exitCode, stdout, stderr }
    } finally {
      await this.cleanup()
    }
  }

  async waitForApplication() {
    for (let n = 0; n < 40; n++) {
      try {
        const response = await this.ctx.container
          .getTcpPort(3000)
          .fetch("http://localhost:3000/", { signal: AbortSignal.timeout(500) })
        await response.body?.cancel()
        if (response.ok) return
      } catch {
        // The app may not be listening yet.
      }
      await scheduler.wait(250)
    }
    throw Error("Probe application did not become ready")
  }

  async openBrowser(request) {
    const path = new URL(request.url).pathname
    if (path === "/echo") {
      const pair = new WebSocketPair()
      pair[1].accept()
      pair[1].addEventListener("message", (event) => pair[1].send(event.data))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    await this.closeBrowser()
    // Creation of the Fetcher and launch deliberately share one invocation.
    const options = {
      keepAlive: 60000,
      guardrails: { allowedDomains: ["candidate.terminus.test"] },
      ...(path === "/cdp"
        ? {
            outboundByHost: {
              "candidate.terminus.test": this.ctx.exports.CandidateOutbound({
                props: { sandbox: this.ctx.id.toString() },
              }),
            },
          }
        : {}),
    }
    const connection = await this.env.BROWSER.launch(options)
    await this.ctx.storage.put("browser", connection.sessionId)
    return connection.webSocket.fetch("https://browser-binding.invalid", {
      headers: { Upgrade: "websocket" },
    })
  }

  app(request) {
    // No caller-selected port or Sandbox is accepted.
    return this.ctx.container.getTcpPort(3000).fetch(request)
  }

  async closeBrowser() {
    const session = await this.ctx.storage.get("browser")
    if (session) {
      await this.env.BROWSER.closeSession(session)
      await this.ctx.storage.delete("browser")
    }
  }

  async cleanup() {
    try {
      await this.closeBrowser()
      await this.ctx.storage.deleteAlarm()
    } finally {
      if (this.ctx.container.running) await this.ctx.container.destroy()
    }
  }

  alarm() {
    return this.cleanup()
  }
}

export class ProbeOutbound extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url)
    if (
      url.origin !== "https://browser.terminus.test" ||
      !["/cdp", "/unrouted", "/echo"].includes(url.pathname) ||
      url.search ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("Denied", { status: 403 })
    return this.env.SANDBOX.get(
      this.env.SANDBOX.idFromString(this.ctx.props.sandbox)
    ).fetch(request)
  }
}

export class CandidateOutbound extends WorkerEntrypoint {
  fetch(request) {
    if (new URL(request.url).origin !== "http://candidate.terminus.test")
      return new Response("Denied", { status: 403 })
    return this.env.SANDBOX.get(
      this.env.SANDBOX.idFromString(this.ctx.props.sandbox)
    ).app(request)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      request.method !== "POST" ||
      url.pathname !== "/prove"
    )
      return new Response("Local POST /prove required", { status: 404 })
    return Response.json(
      await env.SANDBOX.getByName(
        `browser-proof-${crypto.randomUUID()}`
      ).prove()
    )
  },
}

async function capture(stream) {
  if (!stream) return ""
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream)
    text = (text + decoder.decode(chunk, { stream: true })).slice(0, 16000)
  return (text + decoder.decode()).slice(0, 16000)
}
