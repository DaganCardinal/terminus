import {
  ArtifactsRepositoryHost,
  ArtifactsRestClient,
  smartHttpHeadReader,
} from "@terminus/artifacts"
import { cacheOverviews } from "./overview-cache"
import { SandboxWorkspaces } from "./sandbox-workspaces"

/**
 * Real repositories: Artifacts over its REST API, one namespace per Project,
 * with Git running in Sandboxes. Heads are read over smart HTTP and single
 * files over the REST object endpoints, both from the Worker, so checking a
 * head or opening a file in the reader starts no Sandbox. Overviews still need
 * one, but only the first time each commit is browsed.
 */
export function artifactsRepositories(env: Env): ArtifactsRepositoryHost {
  const repositories = new ArtifactsRepositoryHost(
    new ArtifactsRestClient({
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      apiToken: env.ARTIFACTS_API_TOKEN ?? "",
    }),
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000),
    smartHttpHeadReader()
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
