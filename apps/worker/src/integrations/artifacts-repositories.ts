import {
  ArtifactsRepositoryHost,
  ArtifactsRestClient,
  smartHttpHeadReader,
} from "@terminus/artifacts"
import { SandboxWorkspaces } from "./sandbox-workspaces"

/**
 * Real repositories: Artifacts over its REST API, one namespace per Project,
 * with Git running in Sandboxes. Heads are read over smart HTTP from the
 * Worker, so checking a fork or a canonical head starts no Sandbox.
 */
export function artifactsRepositories(env: Env): ArtifactsRepositoryHost {
  return new ArtifactsRepositoryHost(
    new ArtifactsRestClient({
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      apiToken: env.ARTIFACTS_API_TOKEN ?? "",
    }),
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000),
    smartHttpHeadReader()
  )
}
