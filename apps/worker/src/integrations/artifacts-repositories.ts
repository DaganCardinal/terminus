import {
  ArtifactsRepositoryHost,
  ArtifactsRestClient,
} from "@terminus/artifacts"
import { SandboxWorkspaces } from "./sandbox-workspaces"

/**
 * Real repositories: Artifacts over its REST API, one namespace per Project,
 * with Git running in Sandboxes.
 */
export function artifactsRepositories(env: Env): ArtifactsRepositoryHost {
  return new ArtifactsRepositoryHost(
    new ArtifactsRestClient({
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      apiToken: env.ARTIFACTS_API_TOKEN ?? "",
    }),
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000)
  )
}
