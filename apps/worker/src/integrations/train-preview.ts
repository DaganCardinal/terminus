import {
  ArtifactsRepositoryHost,
  type RepositoryAccess,
} from "@terminus/artifacts"
import type { Train } from "@terminus/domain"
import {
  sandboxPreviewResultSchema,
  trainPreviewSchema,
  type SandboxPreviewRequest,
  type TrainPreview,
} from "@terminus/protocol"
import { NetworkStore } from "./network-store"
import { SandboxWorkspaces } from "./sandbox-workspaces"

export class PreviewError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface PreviewSandbox {
  prepareTrainPreview(input: SandboxPreviewRequest): Promise<unknown>
}

/** Local previews go directly to Wrangler, even when the API is proxied by Vite. */
export function previewBaseUrl(requestUrl: string, configured?: string): URL {
  const request = new URL(requestUrl)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)
  if (!configured && !local)
    throw new PreviewError(
      503,
      "Configure PREVIEW_BASE_URL and route its wildcard hostnames to this Worker"
    )
  let url: URL
  try {
    url = new URL(configured || "http://localhost:8787")
  } catch {
    throw new PreviewError(503, "PREVIEW_BASE_URL must be an absolute URL")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    (!local &&
      (url.protocol !== "https:" ||
        url.hostname === request.hostname ||
        url.hostname.endsWith(".workers.dev")))
  )
    throw new PreviewError(
      503,
      "PREVIEW_BASE_URL must be a separate preview origin with wildcard routing"
    )
  return url
}

export async function prepareTrainPreview(
  train: Train,
  base: URL,
  repositories: {
    access(repoId: string, scope: "read"): Promise<RepositoryAccess>
    revoke(access: RepositoryAccess): Promise<void>
  },
  sandboxFor: (name: string) => PreviewSandbox
): Promise<TrainPreview> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${train.id}:${train.repoId}:${train.headCommit}`)
  )
  const name = `preview-${Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`
  const access = await repositories.access(train.repoId, "read")
  try {
    const { token } = sandboxPreviewResultSchema.parse(
      await sandboxFor(name).prepareTrainPreview({
        remote: access.remote,
        token: access.token,
        commit: train.headCommit,
        hostname: base.hostname,
      })
    )
    const url = new URL(base)
    url.hostname = `${name}-${token}.${base.hostname}`
    return trainPreviewSchema.parse({
      trainId: train.id,
      commit: train.headCommit,
      url: url.href,
    })
  } finally {
    await repositories.revoke(access)
  }
}

export async function launchTrainPreview(
  request: Request,
  env: Env,
  trainId: string
): Promise<TrainPreview> {
  const record = await new NetworkStore(env.DB).train(trainId)
  if (!record) throw new PreviewError(404, "Unknown Train")
  if (env.REPOSITORY_MODE !== "artifacts" || !env.ARTIFACTS || !env.SANDBOX)
    throw new PreviewError(
      503,
      "Train previews require real Artifacts repositories and Cloudflare Sandboxes; fake mode has no app to run"
    )
  const base = previewBaseUrl(request.url, env.PREVIEW_BASE_URL)
  const repositories = new ArtifactsRepositoryHost(
    env.ARTIFACTS,
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000)
  )
  try {
    return await prepareTrainPreview(record.value, base, repositories, (name) =>
      env.SANDBOX.getByName(name)
    )
  } catch {
    // Do not expose repository credentials or raw project command output.
    throw new PreviewError(
      502,
      "Could not start the Train preview. Check the demo app installs and builds, then try again."
    )
  }
}

/** Preview hostnames reach only their fixed preview port, including /api paths. */
export async function routeTrainPreview(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url)
  let base: URL
  try {
    base = new URL(env.PREVIEW_BASE_URL || "http://localhost:8787")
  } catch {
    return null
  }
  const suffix = `.${base.hostname}`
  if (!url.hostname.endsWith(suffix)) return null
  const match = /^(preview-[a-f0-9]{24})-([a-f0-9]{24})$/.exec(
    url.hostname.slice(0, -suffix.length)
  )
  if (!match || !env.SANDBOX) return new Response("Not found", { status: 404 })
  return env.SANDBOX.getByName(match[1]!).fetchTrainPreview(request, match[2]!)
}
