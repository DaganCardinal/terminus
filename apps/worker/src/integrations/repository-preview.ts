import type { RepositoryAccess } from "@terminus/artifacts"
import {
  repositoryPreviewSchema,
  sandboxPreviewResultSchema,
  type SandboxPreviewRequest,
} from "@terminus/protocol"
import { artifactsRepositories } from "./artifacts-repositories"

export class PreviewError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface PreviewSandbox {
  prepareTrainPreview(input: SandboxPreviewRequest): Promise<unknown>
}

export interface StoppablePreviewSandbox {
  stopTrainPreview(): Promise<void>
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

export interface RepositoryPreviewSnapshot {
  identity: string
  repoId: string
  commit: string
}

export interface PreviewRepositories {
  access(repoId: string, scope: "read"): Promise<RepositoryAccess>
  revoke(access: RepositoryAccess): Promise<void>
}

/** One Sandbox per previewed snapshot, so the same snapshot is reused. */
async function previewSandboxName(snapshot: RepositoryPreviewSnapshot) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${snapshot.identity}:${snapshot.repoId}:${snapshot.commit}`
    )
  )
  return `preview-${Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`
}

/** Read-only preparation shared by Train and canonical Terminus previews. */
export async function prepareRepositoryPreview(
  snapshot: RepositoryPreviewSnapshot,
  base: URL,
  repositories: PreviewRepositories,
  sandboxFor: (name: string) => PreviewSandbox
) {
  const name = await previewSandboxName(snapshot)
  const access = await repositories.access(snapshot.repoId, "read")
  try {
    const { token } = sandboxPreviewResultSchema.parse(
      await sandboxFor(name).prepareTrainPreview({
        remote: access.remote,
        token: access.token,
        commit: snapshot.commit,
        hostname: base.hostname,
      })
    )
    const url = new URL(base)
    url.hostname = `${name}-${token}.${base.hostname}`
    return repositoryPreviewSchema.parse({
      commit: snapshot.commit,
      url: url.href,
    })
  } finally {
    await repositories.revoke(access)
  }
}

export async function launchRepositoryPreview(
  request: Request,
  env: Env,
  snapshot: RepositoryPreviewSnapshot,
  label: "Train" | "Terminus"
) {
  if (env.REPOSITORY_MODE !== "artifacts" || !env.SANDBOX)
    throw new PreviewError(
      503,
      `${label} previews require real Artifacts repositories and Cloudflare Sandboxes; fake mode has no app to run`
    )
  const base = previewBaseUrl(request.url, env.PREVIEW_BASE_URL)
  const repositories = artifactsRepositories(env)
  try {
    return await prepareRepositoryPreview(
      snapshot,
      base,
      repositories,
      (name) => env.SANDBOX.getByName(name)
    )
  } catch {
    throw new PreviewError(
      502,
      `Could not start the ${label} preview. Check the demo app installs and builds, then try again.`
    )
  }
}

/** Stopping is idempotent: an expired or never-started preview is a no-op. */
export async function stopRepositoryPreview(
  snapshot: RepositoryPreviewSnapshot,
  sandboxFor: (name: string) => StoppablePreviewSandbox
): Promise<void> {
  await sandboxFor(await previewSandboxName(snapshot)).stopTrainPreview()
}

export async function haltRepositoryPreview(
  env: Env,
  snapshot: RepositoryPreviewSnapshot,
  label: "Train" | "Terminus"
): Promise<void> {
  if (env.REPOSITORY_MODE !== "artifacts" || !env.SANDBOX)
    throw new PreviewError(
      503,
      `${label} previews require real Artifacts repositories and Cloudflare Sandboxes; fake mode has no app to run`
    )
  await stopRepositoryPreview(snapshot, (name) => env.SANDBOX.getByName(name))
}
