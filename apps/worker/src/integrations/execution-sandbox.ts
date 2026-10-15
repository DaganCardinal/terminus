import { Files } from "@cloudflare/sandbox"
import { outboundRequest } from "./sandbox-outbound"
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
  SANDBOX_SIZES,
  type SandboxSize,
} from "@terminus/protocol"
import { DurableObject } from "cloudflare:workers"
import {
  browserApplicationPort,
  browserCandidateHost,
  browserRunEnabled,
} from "./browser-run"
import { installDependencies, npmCacheDirectory } from "./dependency-cache"
import {
  acquireSandboxLease,
  releaseSandboxLease,
  renewSandboxLease,
  sandboxKind,
  sandboxLimit,
  sandboxLimits,
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
/** The Browser Run proof closes its container when done; this bounds a crash. */
const browserProofIdleTimeoutMs = 5 * 60_000
const browserProofTimeoutMs = 2 * 60_000
/** Browser Run closes a session idle this long, such as after a crash. */
const browserKeepAliveMs = 60_000
/** A lease outlives its container's idle timeout by a margin, so it lapses
 * on its own only after the container has certainly stopped. */
const leaseMarginMs = 60_000
const leaseRenewalMs = 60_000
/** Workflow callers wait this long for a free Sandbox before failing their
 * step, which then retries; previews, behind a person, never wait. */
const capacityWaitMs = 10 * 60_000
/** Callers that may wait retry a start Cloudflare could not place for this
 * long, pausing 5, 10, 20, then 30 seconds at a time. */
const placementWaitMs = 5 * 60_000
const placementPauseMs = 5_000
const maxPlacementPauseMs = 30_000

/**
 * Cloudflare had no container to give this start ("There is no container
 * instance that can be provided to this Durable Object, try again later").
 * The message is the runtime's only signal; `@cloudflare/containers` retries
 * on the same text. Nothing ran in the container, so starting again is safe.
 */
function isPlacementFailure(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error))
    .toLowerCase()
    .includes(
      "there is no container instance that can be provided to this durable object"
    )
}

export interface StreamOptions {
  /** Follows a process already running in the container: fails rather than starting one. */
  reattach?: boolean
}

/** The Durable Object bindings callers address Sandboxes by, one per kind,
 * as recorded for deletion. */
export type SandboxBinding = "SANDBOX" | "WORKSPACE_SANDBOX"

/** The container class bindings behind each Sandbox binding, one per size.
 * Each holds the kind's image at that size (`wrangler.jsonc`). */
const containerBindings = {
  SANDBOX: {
    "standard-1": "SANDBOX_STANDARD_1",
    "standard-2": "SANDBOX_STANDARD_2",
    "standard-3": "SANDBOX_STANDARD_3",
  },
  WORKSPACE_SANDBOX: {
    "standard-1": "WORKSPACE_SANDBOX_STANDARD_1",
    "standard-2": "WORKSPACE_SANDBOX_STANDARD_2",
    "standard-3": "WORKSPACE_SANDBOX_STANDARD_3",
  },
} as const satisfies Record<SandboxBinding, Record<SandboxSize, keyof Env>>
type ContainerBinding = (typeof containerBindings)[SandboxBinding][SandboxSize]

/** A remote's Artifacts namespace, or null when it isn't an Artifacts remote. */
function artifactsNamespace(remote: string): string | null {
  const match = /^\/git\/([^/]+)\/[^/]+$/.exec(new URL(remote).pathname)
  return match ? decodeURIComponent(match[1]!) : null
}

/**
 * A Sandbox's address. Callers name Sandboxes here, and each routes to a
 * container class of its network's chosen size. It changes size only while
 * no container runs, so a new setting never strands running work; it
 * applies from the next start.
 */
export class ExecutionSandbox extends DurableObject<Env> {
  protected readonly binding: SandboxBinding = "SANDBOX"
  #purged = false
  /** Serializes size choices, so concurrent starts agree on one container. */
  #choosing: Promise<unknown> = Promise.resolve()

  async configure(network: SandboxNetwork): Promise<void> {
    const remotes = sandboxNetworkSchema
      .parse(network)
      .repositories.map((repo) => repo.remote)
    await (await this.choose(remotes)).configure(network)
  }

  async prepareTrainPreview(
    input: SandboxPreviewRequest
  ): Promise<SandboxPreviewResult> {
    const parsed = sandboxPreviewRequestSchema.parse(input)
    return (await this.choose([parsed.remote])).prepareTrainPreview(parsed)
  }

  async fetchTrainPreview(request: Request, token: string): Promise<Response> {
    const container = await this.current()
    if (!container) return new Response("Not found", { status: 404 })
    return container.fetchTrainPreview(request, token)
  }

  async stopTrainPreview(): Promise<void> {
    await (await this.current())?.stopTrainPreview()
  }

  async run(
    command: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number
  ): Promise<CommandResult> {
    return (await this.configured()).run(command, cwd, env, timeoutMs)
  }

  async installDependencies(cwd: string): Promise<CommandResult> {
    return (await this.configured()).installDependencies(cwd)
  }

  async runStream(
    command: string[],
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    return (await this.configured()).runStream(
      command,
      cwd,
      env,
      timeoutMs,
      options
    )
  }

  async write(path: string, contents: string): Promise<void> {
    await (await this.configured()).write(path, contents)
  }

  async close(): Promise<void> {
    await (await this.current())?.close()
  }

  /** Permanently stops this execution address, including a startup racing Stop. */
  async cancel(): Promise<void> {
    await this.ctx.storage.put("cancelled", true)
    const name = await this.name()
    if (name) {
      const results = await Promise.allSettled(
        SANDBOX_SIZES.map((size) => this.container(size, name).cancel())
      )
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Sandbox cancellation cleanup failed")
    }
  }

  /** Runs the Browser Run transport proof, then deletes this Sandbox, which
   * exists only for the proof. */
  async proveBrowserRun(scope: string): Promise<CommandResult> {
    try {
      return await (await this.choose([])).proveBrowserRun(scope)
    } finally {
      await this.purge()
    }
  }

  /** Permanent deletion purges the container of every size this address
   * has started, since earlier starts may have used another size, and then
   * this address's own storage. An address that never started a container
   * wakes none. */
  async purge(): Promise<void> {
    this.#purged = true
    await this.#choosing.catch(() => {})
    const name = await this.name()
    // Without a name, no container was ever started from here.
    if (name)
      for (const size of await this.startedSizes())
        await this.container(size, name).purge()
    await this.ctx.storage.deleteAll()
  }

  /** The sizes this address has chosen a container at. One chosen before
   * these were recorded may have used any size. */
  private async startedSizes(): Promise<SandboxSize[]> {
    const sizes = await this.ctx.storage.get<SandboxSize[]>("sizes")
    if (sizes) return sizes
    return (await this.ctx.storage.get("size")) ? [...SANDBOX_SIZES] : []
  }

  /** The container to start work in: the one already running, else one of
   * the network's current size. */
  private choose(
    remotes: string[]
  ): Promise<DurableObjectStub<SandboxContainer>> {
    const chosen = this.#choosing
      .catch(() => {})
      .then(async () => {
        if (this.#purged) throw new Error("Sandbox was deleted")
        if (await this.ctx.storage.get("cancelled"))
          throw new Error("Sandbox was cancelled")
        const name = this.ctx.id.name
        if (!name) throw new Error("Sandboxes are started by name")
        await this.ctx.storage.put("name", name)
        const current = await this.current()
        if (current && (await current.running())) return current
        let namespace = await this.ctx.storage.get<string>("namespace")
        if (!namespace) {
          namespace = remotes.map(artifactsNamespace).find(Boolean) ?? ""
          if (namespace) await this.ctx.storage.put("namespace", namespace)
        }
        const size = (await sandboxLimits(this.env.DB, namespace)).sizes[
          sandboxKind[this.binding]
        ]
        const sizes = await this.startedSizes()
        await this.ctx.storage.put({
          size,
          sizes: sizes.includes(size) ? sizes : [...sizes, size],
        })
        return this.container(size, name)
      })
    this.#choosing = chosen
    return chosen
  }

  private async current(): Promise<DurableObjectStub<SandboxContainer> | null> {
    const size = await this.ctx.storage.get<SandboxSize>("size")
    const name = await this.name()
    return size && name ? this.container(size, name) : null
  }

  /** This Sandbox's name. Deletion reaches registered Sandboxes by id,
   * which carries no name, so the first start stores it. */
  private async name(): Promise<string | undefined> {
    return this.ctx.id.name ?? (await this.ctx.storage.get<string>("name"))
  }

  private async configured(): Promise<DurableObjectStub<SandboxContainer>> {
    const container = await this.current()
    if (!container)
      throw new Error("Sandbox network capabilities have not been configured")
    return container
  }

  /** Each size's container shares this Sandbox's name, which is what the
   * Containers dashboard shows (such as `station-<runId>`). */
  private container(
    size: SandboxSize,
    name: string
  ): DurableObjectStub<SandboxContainer> {
    const namespace = this.env[
      containerBindings[this.binding][size]
    ] as DurableObjectNamespace<SandboxContainer>
    return namespace.getByName(name)
  }
}

/** The agentless Sandbox: Git workspaces, integration validation and previews. */
export class WorkspaceSandbox extends ExecutionSandbox {
  protected override readonly binding: SandboxBinding = "WORKSPACE_SANDBOX"
}

/**
 * The required Sandbox container adapter, reached only through its Sandbox
 * address. No Train or Station lifecycle lives here.
 */
export abstract class SandboxContainer extends DurableObject<Env> {
  /** The Sandbox binding this container serves: its kind for capacity, and
   * the namespace its address resolves in for deletion. */
  protected readonly binding: SandboxBinding = "SANDBOX"
  /** This container's own class binding, for routes back to it. */
  protected abstract readonly self: ContainerBinding
  #network: SandboxNetwork | null = null
  #cancelled = false
  readonly #outbound = new Set<AbortController>()
  #setup: Promise<void> | null = null
  #previewSetup: Promise<SandboxPreviewResult> | null = null
  #purged = false
  #namespace = ""
  #leaseTtlMs = idleTimeoutMs + leaseMarginMs
  #leaseRenewedAt = 0
  /** Bumped on every start and stop, so a stale exit never releases a newer lease. */
  #leaseGeneration = 0
  #browserSession: string | null = null

  /** Register ownership before a container can start. Random sessions and
   * preview snapshots must be discoverable even after their Workflow exits. */
  private async register(remote?: string): Promise<void> {
    if (this.#purged) throw new Error("Sandbox was deleted")
    const previous = await this.ctx.storage.get<string>("namespace")
    const remoteNamespace = remote ? artifactsNamespace(remote) : null
    if (remote && !remoteNamespace) throw new Error("Invalid Artifacts remote")
    const namespace = remoteNamespace ?? previous
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
    // Record the Sandbox this container serves, which shares its name:
    // deletion purges that Sandbox, which purges every size.
    const name = this.ctx.id.name
    if (!name)
      throw new Error("Sandbox containers are reached through their Sandbox")
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO network_sandboxes (object_id, namespace, binding) VALUES (?, ?, ?)"
    )
      .bind(
        this.env[this.binding].idFromName(name).toString(),
        namespace,
        this.binding
      )
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
        await this.waitForPort(8080, "The preview server")
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
      await this.waitForPort(8080, "The preview server")
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

  private async waitForPort(port: number, server: string): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const response = await this.container()
          .getTcpPort(port)
          .fetch(`http://localhost:${port}/`, {
            signal: AbortSignal.timeout(1000),
          })
        await response.body?.cancel()
        if (response.ok) return
      } catch {
        // The process has started but may not be listening yet.
      }
      await scheduler.wait(250)
    }
    throw new Error(`${server} did not become ready`)
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

  /**
   * The Browser Run transport proof (`docs/browser-run.md`): a candidate
   * application on the fixed port, then the proof client, which drives a
   * remote browser against it through this container's own routes.
   */
  async proveBrowserRun(scope: string): Promise<CommandResult> {
    if (!browserRunEnabled(this.env) || !this.env.BROWSER)
      throw new Error("Browser Run is disabled")
    if (this.binding !== "SANDBOX")
      throw new Error("The Browser Run proof runs in agent Sandboxes")
    try {
      await this.applyNetwork(
        { repositories: [], allowModel: false, allowBrowser: true },
        0,
        true
      )
      await this.container().setInactivityTimeout(browserProofIdleTimeoutMs)
      this.#leaseTtlMs = browserProofIdleTimeoutMs + leaseMarginMs
      await this.renewLease(true)
      const app = await this.container().exec(
        ["node", "/opt/browser-run/app.mjs"],
        {
          env: { PROOF_SCOPE: scope },
          stdin: new ReadableStream({
            start: (controller) => controller.close(),
          }),
          stdout: "ignore",
        }
      )
      // Kept so a failed start can say why; read only once the app exits.
      const appExit = app.exitCode.catch(() => -1)
      const appErrors = capture(app.stderr).catch(() => ({ text: "" }))
      try {
        await this.waitForPort(browserApplicationPort, "The proof application")
      } catch (error) {
        const exited = await Promise.race([appExit, scheduler.wait(0)])
        const listing = await this.run(
          ["sh", "-c", "ls -la /opt/browser-run 2>&1"],
          "/",
          {},
          10_000
        ).catch((failure: unknown) => ({ stdout: String(failure) }))
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            typeof exited === "number"
              ? `It exited with code ${exited}: ${(await appErrors).text.slice(-1500)}`
              : "It is still running",
            `/opt/browser-run: ${listing.stdout.slice(0, 1000)}`,
          ].join(". "),
          { cause: error }
        )
      }
      return await this.run(
        ["node", "/opt/browser-run/proof.mjs"],
        "/opt/browser-run",
        { PROOF_SCOPE: scope },
        browserProofTimeoutMs
      )
    } finally {
      await this.close()
    }
  }

  /**
   * Browser control, reached only from this container's outbound
   * interception (`browserControlRequest`). It must be native `fetch()`:
   * RPC cannot return a WebSocket.
   */
  override async fetch(request: Request): Promise<Response> {
    const browser = this.env.BROWSER
    if (
      !browser ||
      !browserRunEnabled(this.env) ||
      !this.#network?.allowBrowser
    )
      return new Response("Browser Run is not available", { status: 403 })
    const path = new URL(request.url).pathname
    if (path === "/echo") {
      const [client, server] = Object.values(new WebSocketPair())
      server!.accept()
      server!.addEventListener("message", (event) => server!.send(event.data))
      return new Response(null, { status: 101, webSocket: client })
    }
    // One browser per Sandbox: a new connection replaces the last session.
    await this.closeBrowser()
    // The candidate Fetcher and the launch share one invocation, since Browser
    // Run does not keep Fetchers between invocations.
    const connection = await browser.launch({
      keepAlive: browserKeepAliveMs,
      guardrails: { allowedDomains: [browserCandidateHost] },
      ...(path === "/cdp"
        ? {
            outboundByHost: {
              [browserCandidateHost]: this.ctx.exports.BrowserCandidateOutbound(
                {
                  props: {
                    binding: this.self,
                    sandbox: this.ctx.id.toString(),
                  },
                }
              ),
            },
          }
        : {}),
    })
    this.#browserSession = connection.sessionId
    const upgraded = await connection.webSocket.fetch(
      "https://browser-run.invalid/",
      { headers: { Upgrade: "websocket" } }
    )
    if (upgraded.status !== 101 || !upgraded.webSocket) {
      const detail = (await upgraded.text().catch(() => "")).slice(0, 500)
      return new Response(
        `Browser Run refused the CDP upgrade (${upgraded.status}): ${detail}`,
        { status: 502 }
      )
    }
    // Pass on only the socket. Sandbox interception writes its own handshake
    // headers, and Browser Run's would duplicate them (`Upgrade: websocket,
    // websocket`), which WebSocket clients reject.
    return new Response(null, { status: 101, webSocket: upgraded.webSocket })
  }

  /** The remote browser's requests to this Sandbox's application, from the
   * `BrowserCandidateOutbound` this container scoped to itself. */
  async browserApplication(request: Request): Promise<Response> {
    if (
      !browserRunEnabled(this.env) ||
      !this.#network?.allowBrowser ||
      !this.container().running
    )
      return new Response("Not found", { status: 404 })
    return this.container().getTcpPort(browserApplicationPort).fetch(request)
  }

  private async closeBrowser(): Promise<void> {
    const session = this.#browserSession
    this.#browserSession = null
    if (session) await this.env.BROWSER?.closeSession(session).catch(() => {})
  }

  /** Whether a container is running, so its Sandbox keeps using this size. */
  async running(): Promise<boolean> {
    return this.container().running
  }

  /** Configures capabilities and starts the container, waiting up to
   * `waitMs` for the network to have a free Sandbox of this kind. Only the
   * Browser Run proof runs `networkless`. */
  protected async applyNetwork(
    network: SandboxNetwork,
    waitMs: number,
    networkless = false
  ): Promise<void> {
    await this.assertActive()
    const parsed = sandboxNetworkSchema.parse(network)
    for (const repo of parsed.repositories) await this.register(repo.remote)
    await this.register()
    if (this.#purged) throw new Error("Sandbox was deleted")
    // A container starts only for a network, so deletion's fence and registry
    // cover it. Purging erases the namespace, so a call arriving after a
    // purge, once the in-memory flag is gone, cannot start one unfenced.
    if (!this.#namespace && !networkless)
      throw new Error("Sandbox belongs to no network")
    await this.assertActive()
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

  /** Streams command output across the existing Sandbox RPC boundary.
   * Cancelling the stream stops only this command. */
  async runStream(
    command: string[],
    cwd = "/workspace",
    env: Record<string, string> = {},
    timeoutMs = commandTimeoutMs,
    options: StreamOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    // Reattaching follows work in this container, so it never starts a new one.
    if (options.reattach && !this.container().running)
      throw new Error("Sandbox container is not running")
    await this.ready()
    const abort = new AbortController()
    const process = await this.container().exec(command, {
      cwd,
      env: { ...trustEnv, ...env },
      stdin: new ReadableStream({ start: (controller) => controller.close() }),
      stderr: "ignore",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const reader = process.stdout?.getReader()
    if (!reader) throw new Error("Streaming command has no output pipe")
    // Observe rejection immediately, including before the caller starts reading.
    const exit = process.exitCode.then(
      (code) => ({ code }),
      () => ({ code: -1 })
    )
    return new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (!next.done) {
            controller.enqueue(next.value)
          } else {
            if ((await exit).code !== 0)
              throw new Error("Streaming command failed")
            controller.close()
            reader.releaseLock()
          }
        } catch {
          abort.abort()
          controller.error(new Error("Streaming command interrupted"))
        }
      },
      async cancel() {
        abort.abort()
        await reader.cancel().catch(() => {})
      },
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

  /** Outbound calls run here so Stop can abort both pending headers and streams. */
  async outbound(request: Request): Promise<Response> {
    await this.assertActive()
    const network = this.#network
    if (!network) return new Response("Sandbox is closed", { status: 403 })
    const abort = new AbortController()
    this.#outbound.add(abort)
    try {
      const response = await outboundRequest(
        new Request(request, {
          signal: AbortSignal.any([request.signal, abort.signal]),
        }),
        this.env,
        { ...network, sessionAffinity: `ses_${this.ctx.id.toString()}` }
      )
      if (!response.body) {
        this.#outbound.delete(abort)
        return response
      }
      const reader = response.body.getReader()
      const active = this.#outbound
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) {
                active.delete(abort)
                controller.close()
              } else controller.enqueue(next.value)
            } catch (error) {
              active.delete(abort)
              controller.error(error)
            }
          },
          async cancel(reason) {
            abort.abort()
            active.delete(abort)
            await reader.cancel(reason)
          },
        }),
        response
      )
    } catch (error) {
      this.#outbound.delete(abort)
      throw error
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true
    await this.ctx.storage.put("cancelled", true)
    await this.close()
  }

  private async assertActive(): Promise<void> {
    if (this.#cancelled || (await this.ctx.storage.get("cancelled")))
      throw new Error("Sandbox was cancelled")
    if (this.#purged) throw new Error("Sandbox was deleted")
  }

  async close(): Promise<void> {
    for (const abort of this.#outbound) abort.abort()
    this.#outbound.clear()
    await this.closeBrowser()
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
    await this.assertActive()
    await this.register()
    if (this.#purged) throw new Error("Sandbox was deleted")
    if (!this.#network)
      throw new Error("Sandbox network capabilities have not been configured")
    if (!this.#setup || !this.container().running) {
      this.#setup = this.setUp(this.#network, waitMs).catch(
        (error: unknown) => {
          this.#setup = null
          throw error
        }
      )
    }
    await this.#setup
    await this.assertActive()
    await this.renewLease()
    await this.assertActive()
  }

  /**
   * Starts the container, or attaches to the running one. Callers that may
   * wait retry a start Cloudflare could not place, freeing the network's
   * slot while they pause, so a Station or integration doesn't fail on it.
   */
  private async setUp(network: SandboxNetwork, waitMs: number): Promise<void> {
    const retry = waitMs > 0
    // Counted from the first unplaced start, not from any wait for a slot.
    let deadline: number | undefined
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.setUpOnce(network, waitMs, retry)
      } catch (error) {
        await this.container().destroy()
        await this.releaseLease()
        if (!retry || !isPlacementFailure(error)) throw error
        deadline ??= Date.now() + placementWaitMs
        const pauseMs = Math.min(
          placementPauseMs * 2 ** (attempt - 1),
          maxPlacementPauseMs
        )
        if (Date.now() + pauseMs > deadline)
          throw new Error(
            `Cloudflare could not provide a Sandbox container after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        console.warn("Sandbox container could not be placed; retrying", {
          sandbox: this.ctx.id.name,
          attempt,
          pauseMs,
        })
        await this.pause(pauseMs)
        await this.assertActive()
      }
    }
  }

  private async setUpOnce(
    network: SandboxNetwork,
    waitMs: number,
    confirmPlacement: boolean
  ): Promise<void> {
    const container = this.container()
    const cold = !container.running
    if (!container.running) {
      await this.acquireLease(waitMs)
      await this.assertActive()
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
        ...(this.ctx.id.name?.startsWith("dispatch-")
          ? {
              outboundSandbox: {
                binding: this.self,
                sandbox: this.ctx.id.toString(),
              },
            }
          : {}),
        sessionAffinity: `ses_${this.ctx.id.toString()}`,
        ...(network.allowBrowser
          ? {
              browserSandbox: {
                binding: this.self,
                sandbox: this.ctx.id.toString(),
              },
            }
          : {}),
      },
    })
    await this.assertActive()
    await container.interceptAllOutboundHttp(outbound)
    await container.interceptOutboundHttps("*", outbound)
    if (cold && confirmPlacement) {
      // start() reports nothing, and an unplaced start fails the first
      // command. Fail it here instead, where it can be retried before any
      // caller's command has run.
      const probe = await container.exec(["true"], {
        stdin: new ReadableStream({
          start: (controller) => controller.close(),
        }),
        stdout: "ignore",
        stderr: "ignore",
      })
      await probe.exitCode
    }
  }

  /** A pause between start attempts; tests replace it. */
  protected async pause(ms: number): Promise<void> {
    await scheduler.wait(ms)
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
      await this.assertActive()
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

export class ExecutionSandboxStandard1 extends SandboxContainer {
  protected readonly self = "SANDBOX_STANDARD_1"
}
export class ExecutionSandboxStandard2 extends SandboxContainer {
  protected readonly self = "SANDBOX_STANDARD_2"
}
export class ExecutionSandboxStandard3 extends SandboxContainer {
  protected readonly self = "SANDBOX_STANDARD_3"
}

/**
 * The agentless container. Its image has no harness, and it refuses model
 * access outright, so work routed here can never reach a model even if a
 * caller asks.
 */
export abstract class WorkspaceSandboxContainer extends SandboxContainer {
  protected override readonly binding: SandboxBinding = "WORKSPACE_SANDBOX"

  protected override async applyNetwork(
    network: SandboxNetwork,
    waitMs: number,
    networkless = false
  ): Promise<void> {
    if (sandboxNetworkSchema.parse(network).allowModel)
      throw new Error("Workspace Sandboxes are never granted model access")
    await super.applyNetwork(network, waitMs, networkless)
  }
}

export class WorkspaceSandboxStandard1 extends WorkspaceSandboxContainer {
  protected readonly self = "WORKSPACE_SANDBOX_STANDARD_1"
}
export class WorkspaceSandboxStandard2 extends WorkspaceSandboxContainer {
  protected readonly self = "WORKSPACE_SANDBOX_STANDARD_2"
}
export class WorkspaceSandboxStandard3 extends WorkspaceSandboxContainer {
  protected readonly self = "WORKSPACE_SANDBOX_STANDARD_3"
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
