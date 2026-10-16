/**
 * The Cloudflare account and API token the Worker uses for Artifacts and
 * models. One of each is enough: CLOUDFLARE_ACCOUNT_ID and the
 * CLOUDFLARE_RUNTIME_TOKEN secret. The older per-service names still work
 * when the new ones are unset.
 */
export type CloudflareAccountEnv = Partial<
  Pick<
    Env,
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_RUNTIME_TOKEN"
    | "ARTIFACTS_ACCOUNT_ID"
    | "ARTIFACTS_API_TOKEN"
    | "AI_GATEWAY_ACCOUNT_ID"
    | "AI_GATEWAY_TOKEN"
  >
>

export function artifactsAccount(env: CloudflareAccountEnv) {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || env.ARTIFACTS_ACCOUNT_ID || "",
    apiToken: env.CLOUDFLARE_RUNTIME_TOKEN || env.ARTIFACTS_API_TOKEN || "",
  }
}

export function modelAccount(env: CloudflareAccountEnv) {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || env.AI_GATEWAY_ACCOUNT_ID || "",
    token: env.CLOUDFLARE_RUNTIME_TOKEN || env.AI_GATEWAY_TOKEN || "",
  }
}
