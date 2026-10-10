import type { Train } from "@terminus/domain"
import { trainPreviewSchema, type TrainPreview } from "@terminus/protocol"
import { NetworkStore } from "./network-store"
import {
  haltRepositoryPreview,
  launchRepositoryPreview,
  prepareRepositoryPreview,
  PreviewError,
  type PreviewRepositories,
  type PreviewSandbox,
} from "./repository-preview"

export { PreviewError, previewBaseUrl } from "./repository-preview"

export async function prepareTrainPreview(
  train: Train,
  base: URL,
  repositories: PreviewRepositories,
  sandboxFor: (name: string) => PreviewSandbox
): Promise<TrainPreview> {
  return trainPreviewSchema.parse({
    trainId: train.id,
    ...(await prepareRepositoryPreview(
      { identity: train.id, repoId: train.repoId, commit: train.headCommit },
      base,
      repositories,
      sandboxFor
    )),
  })
}

export async function launchTrainPreview(
  request: Request,
  env: Env,
  trainId: string
): Promise<TrainPreview> {
  const record = await new NetworkStore(env.DB).train(trainId)
  if (!record) throw new PreviewError(404, "Unknown Train")
  const train = record.value
  return trainPreviewSchema.parse({
    trainId,
    ...(await launchRepositoryPreview(
      request,
      env,
      { identity: train.id, repoId: train.repoId, commit: train.headCommit },
      "Train"
    )),
  })
}

/** Takes the commit the preview was built from, since the Train may have
 * moved on since then. */
export async function stopTrainPreview(
  env: Env,
  trainId: string,
  commit: string
): Promise<void> {
  const record = await new NetworkStore(env.DB).train(trainId)
  if (!record) throw new PreviewError(404, "Unknown Train")
  const train = record.value
  await haltRepositoryPreview(
    env,
    { identity: train.id, repoId: train.repoId, commit },
    "Train"
  )
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
  // A dedicated preview domain's apex must never serve the control app or API.
  if (env.PREVIEW_BASE_URL && url.hostname === base.hostname)
    return ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ? null
      : new Response("Not found", { status: 404 })
  const suffix = `.${base.hostname}`
  if (!url.hostname.endsWith(suffix)) return null
  const match = /^(preview-[a-f0-9]{24})-([a-f0-9]{24})$/.exec(
    url.hostname.slice(0, -suffix.length)
  )
  if (!match || !env.SANDBOX) return new Response("Not found", { status: 404 })
  return env.SANDBOX.getByName(match[1]!).fetchTrainPreview(request, match[2]!)
}
