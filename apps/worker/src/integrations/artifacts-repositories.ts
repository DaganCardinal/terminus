import {
  ArtifactsRepositoryHost,
  ArtifactsRestClient,
  smartHttpHeadReader,
} from "@terminus/artifacts"
import { cacheOverviews } from "./overview-cache"
import { SandboxWorkspaces } from "./sandbox-workspaces"
import { workerGitPromotion } from "./worker-git"

/**
 * Real repositories: Artifacts over its REST API, one namespace per Project,
 * with merge Git running in Sandboxes and bounded fast-forward promotion in
 * the Worker. Heads use smart HTTP; files and overviews use REST object reads.
 */
export function artifactsRepositories(env: Env): ArtifactsRepositoryHost {
  const readHead = smartHttpHeadReader()
  const repositories = new ArtifactsRepositoryHost(
    new ArtifactsRestClient({
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      apiToken: env.ARTIFACTS_API_TOKEN ?? "",
    }),
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000),
    readHead,
    workerGitPromotion(readHead)
  )
  cacheOverviews(repositories, env.DB)
  const createTerminus = repositories.createTerminus.bind(repositories)
  repositories.createTerminus = async (input) => {
    await env.DB.prepare(
      "INSERT INTO repository_provisions (namespace) VALUES (?)"
    )
      .bind(input.namespace)
      .run()
    try {
      return await createTerminus(input)
    } finally {
      await env.DB.prepare(
        "DELETE FROM repository_provisions WHERE namespace = ?"
      )
        .bind(input.namespace)
        .run()
    }
  }
  return repositories
}
