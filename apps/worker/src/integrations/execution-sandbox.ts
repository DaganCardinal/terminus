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
import { installDependencies, npmCacheDirectory } from "./dependency-cache"
import {
  acquireSandboxLease,
  releaseSandboxLease,
  renewSandboxLease,
  sandboxKind,
  sandboxLimit,
  SANDBOX_CAPACITY_MESSAGE,
} from "./sandbox-capacity"

const trustEnv = {
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_cache: npmCacheDirectory,
}

const commandTimeoutMs = 20 * 60_000
const idleTimeoutMs = 30 * 60_000
const previewIdleTimeoutMs = 5 * 60_000
/** A lease outlives its container's idle timeout by a margin, so it lapses
 * on its own only after the container has certainly stopped. */
const leaseMarginMs = 60_000
const leaseRenewalMs = 60_000
/** Workflow callers wait this long for a free Sandbox before failing their
 * step, which then retries; previews, behind a person, never wait. */
const capacityWaitMs = 10 * 60_000

/** The Durable Object bindings that hold Sandboxes, as recorded for deletion. */
export type SandboxBinding = "SANDBOX" | "WORKSPACE_SANDBOX"

/** The required Sandbox container adapter. No Train or Station lifecycle lives here. */
export class ExecutionSandbox extends DurableObject<Env> {
  /** Object ids only resolve in their own namespace, so registration records it. */
  protected readonly binding: SandboxBinding = "SANDBOX"
  #network: SandboxNetwork | null = null
  #setup: Promise<void> | null = null
  #previewSetup: Promise<SandboxPreviewResult> | null = null
  #purged = false
  #namespace = ""
  #leaseTtlMs = idleTimeoutMs + leaseMarginMs
  #leaseRenewedAt = 0
  /** Bumped on every start and stop, so a stale exit never releases a newer lease. */
  #leaseGeneration = 0

  /** Register ownership before a container can start. Random sessions and
   * preview snapshots must be discoverable even after their Workflow exits. */
  private async register(remote?: string): Promise<void> {
    if (this.#purged) throw new Error("Sandbox was deleted")
    const previous = await this.ctx.storage.get<string>("namespace")
    const match =
      remote && /^\/git\/([^/]+)\/[^/]+$/.exec(new URL(remote).pathname)
    const namespace = match ? decodeURIComponent(match[1]!) : previous
    if (remote && !match) throw new Error("Invalid Artifacts remote")
    if (!namespace) return
    this.#namespace = namespace
    if (previous && previous !== namespace)
      throw new Error("Sandbox cannot change network ownership")
    const permitted = await this.env.DB.prepare(
      "SELECT id FROM networks WHERE terminus_repo_id = ? AND deleting = 0 UNION ALL SELECT namespace FROM repository_provisions WHERE namespace = ?"
    )
      .bind(`${namespace}/terminus`, namespace)
      .first()
    if (!permitted) throw new Error("Network is deleting or no longer exists")
    if (this.#purged) throw new Error("Sandbox was deleted")
    if (previous) return
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO network_sandboxes (object_id, namespace, binding) VALUES (?, ?, ?)"
    )
      .bind(this.ctx.id.toString(), namespace, this.binding)
      .run()
    if (this.#purged) throw new Error("Sandbox was deleted")
    await this.ctx.storage.put("namespace", namespace)
  }

  async prepareTrainPreview(
    input: SandboxPreviewRequest
  ): Promise<SandboxPreviewResult> {
    const parsed = sandboxPreviewRequestSchema.parse(input)
    await this.register(parsed.remote)
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
      await this.applyNetwork(
        {
          repositories: [
            { remote: input.remote, token: input.token, scope: "read" },
          ],
          allowModel: false,
        },
        0
      )
      await checkoutPreview(this, input.remote, input.commit)
      if ((await this.installDependencies("/workspace/preview")).exitCode !== 0)
        throw new Error("Preview ci failed")
      const built = await this.run(
        ["npm", "run", "build"],
        "/workspace/preview"
      )
      if (built.exitCode !== 0) throw new Error("Preview run failed")
      // Remove Git access before serving the app. No model access is granted.
      await this.applyNetwork({ repositories: [], allowModel: false }, 0)
      await this.container().setInactivityTimeout(previewIdleTimeoutMs)
      this.#leaseTtlMs = previewIdleTimeoutMs + leaseMarginMs
      await this.renewLease(true)
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
        "This preview has stopped or expired. Open the network and prepare the preview again.",
        { status: 410 }
      )
    await this.renewLease()
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

  /** Stops the preview server now instead of waiting for the inactivity
   * timeout. The token is kept, so open tabs report a stopped preview. */
  async stopTrainPreview(): Promise<void> {
    this.#network = null
    this.#setup = null
    if (this.container().running) await this.container().destroy()
    await this.releaseLease()
  }

  async configure(network: SandboxNetwork): Promise<void> {
    await this.applyNetwork(network, capacityWaitMs)
  }

  /** Configures capabilities and starts the container, waiting up to
   * `waitMs` for the network to have a free Sandbox of this kind. */
  protected async applyNetwork(
    network: SandboxNetwork,
    waitMs: number
  ): Promise<void> {
    const parsed = sandboxNetworkSchema.parse(network)
    for (const repo of parsed.repositories) await this.register(repo.remote)
    await this.register()
    if (this.#purged) throw new Error("Sandbox was deleted")
    this.#network = parsed
    this.#setup = null
    await this.ready(waitMs)
  }

  async run(
    command: string[],
    cwd = "/workspace",
    env: Record<string, string> = {},
    timeoutMs = commandTimeoutMs
  ): Promise<CommandResult> {
    await this.ready()
    const process = await this.container().exec(command, {
      cwd,
      stdin: new ReadableStream({ start: (controller) => controller.close() }),
      env: { ...trustEnv, ...env },
      signal: AbortSignal.timeout(timeoutMs),
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

  /** Installs dependencies in `cwd` with the shared, lockfile-keyed npm cache. */
  async installDependencies(cwd: string): Promise<CommandResult> {
    await this.ready()
    return installDependencies(
      {
        run: (command, dir) => this.run(command, dir),
        stream: async (command, stdin) => {
          const process = await this.container().exec(command, {
            env: trustEnv,
            signal: AbortSignal.timeout(commandTimeoutMs),
            ...(stdin
              ? { stdin, stdout: "ignore" }
              : {
                  stdin: new ReadableStream({
                    start: (controller) => controller.close(),
                  }),
                }),
            stderr: "ignore",
          })
          return { stdout: process.stdout, exitCode: process.exitCode }
        },
      },
      this.env.DEPENDENCY_CACHE,
      cwd
    )
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
    await this.releaseLease()
  }

  /** Permanent deletion removes the container and all Durable Object storage. */
  async purge(): Promise<void> {
    this.#purged = true
    await this.#setup?.catch(() => {})
    await this.close()
    await this.ctx.storage.deleteAll()
  }

  private container(): Container {
    if (!this.ctx.container)
      throw new Error("Sandbox container binding is missing")
    return this.ctx.container
  }

  private async ready(waitMs = capacityWaitMs): Promise<void> {
    await this.register()
    if (this.#purged) throw new Error("Sandbox was deleted")
    if (!this.#network)
      throw new Error("Sandbox network capabilities have not been configured")
    if (!this.#setup || !this.container().running) {
      const network = this.#network
      this.#setup = (async () => {
        const container = this.container()
        if (!container.running) {
          await this.acquireLease(waitMs)
          container.start({ enableInternet: false })
        } else await this.renewLease(true)
        this.watchExit(container)
        // Install the idle limit before network setup, which may fail or hang.
        await container.setInactivityTimeout(idleTimeoutMs)
        // One affinity per Sandbox keeps a harness session's turns on one
        // model instance, which caches their shared prompt prefix.
        const outbound = this.ctx.exports.SandboxOutbound({
          props: {
            ...network,
            sessionAffinity: `ses_${this.ctx.id.toString()}`,
          },
        })
        await container.interceptAllOutboundHttp(outbound)
        await container.interceptOutboundHttps("*", outbound)
      })().catch(async (error: unknown) => {
        this.#setup = null
        await this.container().destroy()
        await this.releaseLease()
        throw error
      })
    }
    await this.#setup
    await this.renewLease()
  }

  #lease() {
    return {
      objectId: this.ctx.id.toString(),
      namespace: this.#namespace,
      binding: this.binding,
    }
  }

  /** Waits for a free Sandbox of this kind on the network, polling with backoff. */
  private async acquireLease(waitMs: number): Promise<void> {
    const lease = this.#lease()
    const deadline = Date.now() + waitMs
    let delay = 1000
    let limit: number
    for (;;) {
      limit = await sandboxLimit(this.env.DB, lease)
      if (
        await acquireSandboxLease(
          this.env.DB,
          lease,
          limit,
          Date.now(),
          this.#leaseTtlMs
        )
      ) {
        this.#leaseGeneration++
        this.#leaseRenewedAt = Date.now()
        return
      }
      if (Date.now() + delay > deadline) break
      if (delay === 1000)
        console.info("Sandbox waiting for capacity", {
          namespace: lease.namespace,
          kind: sandboxKind[lease.binding],
          limit,
        })
      await scheduler.wait(delay)
      delay = Math.min(delay * 2, 15_000)
    }
    throw new Error(
      `${SANDBOX_CAPACITY_MESSAGE}: this network already runs ${limit} ${sandboxKind[lease.binding]} Sandbox${limit === 1 ? "" : "es"}. Wait for running work to finish, or raise the limit in Settings.`
    )
  }

  /** Keeps a running container counted; throttled, since every command
   * calls it. Callers have already found the container running. */
  private async renewLease(force = false): Promise<void> {
    if (!force && Date.now() - this.#leaseRenewedAt < leaseRenewalMs) return
    this.#leaseRenewedAt = Date.now()
    await renewSandboxLease(
      this.env.DB,
      this.#lease(),
      Date.now(),
      this.#leaseTtlMs
    )
  }

  private async releaseLease(): Promise<void> {
    this.#leaseGeneration++
    this.#leaseRenewedAt = 0
    this.#leaseTtlMs = idleTimeoutMs + leaseMarginMs
    await releaseSandboxLease(this.env.DB, this.ctx.id.toString())
  }

  /** Frees the slot as soon as the container stops on its own, such as idling out. */
  private watchExit(container: Container): void {
    const generation = this.#leaseGeneration
    void container
      .monitor()
      .catch(() => {})
      .then(async () => {
        if (generation !== this.#leaseGeneration) return
        this.#setup = null
        await this.releaseLease()
      })
      .catch(() => {})
  }
}

/**
 * The agentless Sandbox: Git workspaces, integration validation and previews.
 * Its image has no harness, and it refuses model access outright, so work
 * routed here can never reach a model even if a caller asks.
 */
export class WorkspaceSandbox extends ExecutionSandbox {
  protected override readonly binding: SandboxBinding = "WORKSPACE_SANDBOX"

  protected override async applyNetwork(
    network: SandboxNetwork,
    waitMs: number
  ): Promise<void> {
    if (sandboxNetworkSchema.parse(network).allowModel)
      throw new Error("Workspace Sandboxes are never granted model access")
    await super.applyNetwork(network, waitMs)
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
