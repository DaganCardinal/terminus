import { Files } from "@cloudflare/sandbox"
import { checkoutPreview } from "@terminus/artifacts"
import {
  commandResultSchema,
  sandboxNetworkSchema,
  type CommandResult,
  type SandboxNetwork,
  sandboxPreviewRequestSchema,
  previewTokenSchema,
  type SandboxPreviewRequest,
  type SandboxPreviewResult,
} from "@terminus/protocol"
import { DurableObject } from "cloudflare:workers"

const trustEnv = {
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  GIT_TERMINAL_PROMPT: "0",
}

/** The required Sandbox container adapter. No Train or Station lifecycle lives here. */
export class ExecutionSandbox extends DurableObject<Env> {
  #network: SandboxNetwork | null = null
  #setup: Promise<void> | null = null
  #previewSetup: Promise<SandboxPreviewResult> | null = null

  async prepareTrainPreview(
    input: SandboxPreviewRequest
  ): Promise<SandboxPreviewResult> {
    const parsed = sandboxPreviewRequestSchema.parse(input)
    if (!this.#previewSetup) {
      this.#previewSetup = this.startTrainPreview(parsed).finally(() => {
        this.#previewSetup = null
      })
    }
    return this.#previewSetup
  }

  private async startTrainPreview(
    input: SandboxPreviewRequest
  ): Promise<SandboxPreviewResult> {
    const saved = await this.ctx.storage.get<{
      token: string
      commit: string
      remote: string
    }>("trainPreview")
    if (saved && this.container().running) {
      if (saved.commit !== input.commit || saved.remote !== input.remote)
        throw new Error("Preview belongs to a different repository snapshot")
      try {
        await this.waitForPreview()
        return { token: previewTokenSchema.parse(saved.token) }
      } catch {
        // A crashed server is rebuilt on the next explicit preview request.
      }
    }
    await this.close()
    try {
      await this.configure({
        repositories: [
          { remote: input.remote, token: input.token, scope: "read" },
        ],
        allowModel: false,
      })
      await checkoutPreview(this, input.remote, input.commit)
      for (const command of [
        ["npm", "ci"],
        ["npm", "run", "build"],
      ]) {
        const result = await this.run(command, "/workspace/preview")
        if (result.exitCode !== 0)
          throw new Error(`Preview ${command[1]} failed`)
      }
      // Remove Git access before serving the app. No model access is granted.
      await this.configure({ repositories: [], allowModel: false })
      await this.container().setInactivityTimeout(5 * 60_000)
      await this.container().exec(
        [
          "node",
          "node_modules/vite/bin/vite.js",
          "preview",
          "--host",
          "0.0.0.0",
          "--port",
          "8080",
          "--strictPort",
        ],
        {
          cwd: "/workspace/preview",
          env: {
            ...trustEnv,
            __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${input.hostname}`,
          },
          stdin: new ReadableStream({
            start: (controller) => controller.close(),
          }),
          stdout: "ignore",
          stderr: "ignore",
        }
      )
      await this.waitForPreview()
      const token = crypto.randomUUID().replaceAll("-", "").slice(0, 24)
      await this.ctx.storage.put("trainPreview", {
        token,
        commit: input.commit,
        remote: input.remote,
      })
      return { token }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private async waitForPreview(): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const response = await this.container()
          .getTcpPort(8080)
          .fetch("http://localhost:8080/", {
            signal: AbortSignal.timeout(1000),
          })
        await response.body?.cancel()
        if (response.ok) return
      } catch {
        // The process has started but may not be listening yet.
      }
      await scheduler.wait(250)
    }
    throw new Error("The preview server did not become ready")
  }

  async fetchTrainPreview(request: Request, token: string): Promise<Response> {
    const saved = await this.ctx.storage.get<{ token: string }>("trainPreview")
    if (!saved || token !== saved.token)
      return new Response("Not found", { status: 404 })
    if (!this.container().running)
      return new Response(
        "This preview has expired. Open the network and prepare the preview again.",
        { status: 410 }
      )
    const url = new URL(request.url)
    url.protocol = "http:"
    const forwarded = new Request(url, request)
    forwarded.headers.delete("cookie")
    forwarded.headers.delete("authorization")
    for (const name of [...forwarded.headers.keys()]) {
      if (name.startsWith("cf-access-")) forwarded.headers.delete(name)
    }
    try {
      const response = await this.container().getTcpPort(8080).fetch(forwarded)
      const headers = new Headers(response.headers)
      headers.set("cache-control", "no-store")
      headers.set("referrer-policy", "no-referrer")
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(
        "The preview stopped responding. Open the network and prepare the preview again.",
        { status: 502 }
      )
    }
  }

  async configure(network: SandboxNetwork): Promise<void> {
    this.#network = sandboxNetworkSchema.parse(network)
    this.#setup = null
    await this.ready()
  }

  async run(
    command: string[],
    cwd = "/workspace",
    env: Record<string, string> = {}
  ): Promise<CommandResult> {
    await this.ready()
    const process = await this.container().exec(command, {
      cwd,
      stdin: new ReadableStream({ start: (controller) => controller.close() }),
      env: { ...trustEnv, ...env },
      signal: AbortSignal.timeout(20 * 60_000),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      capture(process.stdout),
      capture(process.stderr),
      process.exitCode,
    ])
    return commandResultSchema.parse({
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated,
    })
  }

  async write(path: string, contents: string): Promise<void> {
    await this.ready()
    await new Files(this.container()).writeFile(path, contents)
  }

  async close(): Promise<void> {
    this.#network = null
    this.#setup = null
    await this.ctx.storage.delete("trainPreview")
    if (this.container().running) await this.container().destroy()
  }

  private container(): Container {
    if (!this.ctx.container)
      throw new Error("Sandbox container binding is missing")
    return this.ctx.container
  }

  private async ready(): Promise<void> {
    if (!this.#network)
      throw new Error("Sandbox network capabilities have not been configured")
    if (!this.#setup || !this.container().running) {
      const network = this.#network
      this.#setup = (async () => {
        const container = this.container()
        if (!container.running) container.start({ enableInternet: false })
        const outbound = this.ctx.exports.SandboxOutbound({ props: network })
        await container.interceptAllOutboundHttp(outbound)
        await container.interceptOutboundHttps("*", outbound)
        await container.setInactivityTimeout(30 * 60_000)
      })().catch(async (error: unknown) => {
        this.#setup = null
        await this.container().destroy()
        throw error
      })
    }
    await this.#setup
  }
}

async function capture(
  stream: ReadableStream | null
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false }
  const decoder = new TextDecoder()
  let text = ""
  let truncated = false
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    const next = decoder.decode(chunk, { stream: true })
    const available = 1_000_000 - text.length
    text += next.slice(0, Math.max(0, available))
    if (next.length > available) truncated = true
  }
  text += decoder.decode()
  return { text, truncated }
}
