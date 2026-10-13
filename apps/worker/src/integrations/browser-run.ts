import {
  browserRunProofReportSchema,
  type BrowserRunProof,
  type CommandResult,
} from "@terminus/protocol"
import { WorkerEntrypoint } from "cloudflare:workers"
import { z } from "zod"
import type { SandboxContainer } from "./execution-sandbox"

/**
 * Browser Run for Sandboxes, gated by `BROWSER_RUN_ENABLED`. Today only the
 * deployed transport proof uses it (`docs/browser-run.md`):
 *
 * Sandbox → outbound interception (`browser.terminus.test`) → the Sandbox's
 * own container Durable Object, whose native `fetch()` launches a Browser Run
 * session and returns its CDP WebSocket → the remote browser loads
 * `candidate.terminus.test`, which Browser Run sends to a scoped
 * `BrowserCandidateOutbound` → that Sandbox's fixed application port.
 *
 * Neither host is public. Both routes refuse unless the flag is on and the
 * Sandbox's current network grants `allowBrowser`.
 */

/** Where a Sandbox reaches Browser Run, only through outbound interception. */
export const browserControlHost = "browser.terminus.test"
/** The hostname the remote browser loads the Sandbox's application at. */
export const browserCandidateHost = "candidate.terminus.test"
/** The fixed port the Sandbox's application serves the browser on. */
export const browserApplicationPort = 3000

/** The stages the in-Sandbox client must report, in order. */
export const browserRunProofStages = [
  "sandbox_websocket_interception",
  "remote_browser_cdp",
  "private_application",
] as const

export function browserRunEnabled(
  env: Pick<Env, "BROWSER_RUN_ENABLED">
): boolean {
  return env.BROWSER_RUN_ENABLED === "true"
}

const containerBindings = [
  "SANDBOX_STANDARD_1",
  "SANDBOX_STANDARD_2",
  "SANDBOX_STANDARD_3",
  "WORKSPACE_SANDBOX_STANDARD_1",
  "WORKSPACE_SANDBOX_STANDARD_2",
  "WORKSPACE_SANDBOX_STANDARD_3",
] as const

/** A container Durable Object, set by the container from its own identity. */
export const browserSandboxSchema = z.strictObject({
  binding: z.enum(containerBindings),
  sandbox: z.string().regex(/^[0-9a-f]{64}$/),
})
export type BrowserSandbox = z.infer<typeof browserSandboxSchema>

function container(
  env: Env,
  sandbox: BrowserSandbox
): DurableObjectStub<SandboxContainer> {
  const namespace = env[
    sandbox.binding
  ] as DurableObjectNamespace<SandboxContainer>
  return namespace.get(namespace.idFromString(sandbox.sandbox))
}

/**
 * A Sandbox's request to its browser control host. `/echo` checks WebSocket
 * interception alone, `/unrouted` opens a session without the candidate
 * route, and `/cdp` opens one with it. The upgrade goes to the container's
 * native `fetch()`, since RPC cannot return a WebSocket.
 */
export function browserControlRequest(
  request: Request,
  env: Env,
  sandbox: unknown
): Promise<Response> | Response {
  const url = new URL(request.url)
  const owner = browserSandboxSchema.safeParse(sandbox)
  if (
    !browserRunEnabled(env) ||
    !owner.success ||
    url.origin !== `https://${browserControlHost}` ||
    !["/echo", "/unrouted", "/cdp"].includes(url.pathname) ||
    url.search ||
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  )
    return denied()
  return container(env, owner.data).fetch(request)
}

/**
 * The remote browser's requests to the candidate host, created per session
 * by the container that launched it and scoped to that container.
 */
export class BrowserCandidateOutbound extends WorkerEntrypoint<
  Env,
  BrowserSandbox
> {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url)
    const owner = browserSandboxSchema.safeParse(this.ctx.props)
    if (
      !browserRunEnabled(this.env) ||
      !owner.success ||
      url.origin !== `http://${browserCandidateHost}` ||
      url.username ||
      url.password
    )
      return denied()
    return container(this.env, owner.data).browserApplication(request)
  }
}

/**
 * Runs the transport proof in a fresh, throwaway agent Sandbox. Every failure
 * is reported in the result, never thrown, so the caller sees why.
 */
export async function proveBrowserRun(env: Env): Promise<BrowserRunProof> {
  const sandbox = `browser-proof-${crypto.randomUUID()}`
  const started = Date.now()
  let proof: BrowserRunProof
  try {
    const result = await env.SANDBOX.getByName(sandbox).proveBrowserRun(
      crypto.randomUUID()
    )
    proof = readBrowserRunProof(sandbox, Date.now() - started, result)
  } catch (error) {
    proof = {
      passed: false,
      sandbox,
      durationMs: Date.now() - started,
      stages: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  console.info("Browser Run proof finished", {
    sandbox,
    passed: proof.passed,
    durationMs: proof.durationMs,
    error: proof.error,
    stages: proof.stages.map(({ name, passed, error }) => ({
      name,
      passed,
      error,
    })),
  })
  return proof
}

/** The proof passes only if the client reported every stage passing. */
export function readBrowserRunProof(
  sandbox: string,
  durationMs: number,
  result: CommandResult
): BrowserRunProof {
  const common = {
    sandbox,
    durationMs,
    exitCode: result.exitCode,
    stderr: result.stderr.slice(-4000),
  }
  let report
  try {
    report = browserRunProofReportSchema.parse(
      JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")
    )
  } catch {
    return {
      ...common,
      passed: false,
      stages: [],
      error: `The proof client printed no report: ${result.stdout.slice(-1000)}`,
    }
  }
  const complete =
    report.results.length === browserRunProofStages.length &&
    report.results.every(
      (stage, index) =>
        stage.name === browserRunProofStages[index] && stage.passed
    )
  return {
    ...common,
    passed: report.passed && complete && result.exitCode === 0,
    stages: report.results,
  }
}

function denied(): Response {
  return new Response("Destination is not available to this Sandbox", {
    status: 403,
  })
}
