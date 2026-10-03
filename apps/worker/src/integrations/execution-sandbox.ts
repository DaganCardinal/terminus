import { Files } from "@cloudflare/sandbox"
import {
  commandResultSchema,
  sandboxNetworkSchema,
  type CommandResult,
  type SandboxNetwork,
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
