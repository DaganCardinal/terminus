// This deployment's Wrangler configuration: the shared wrangler.jsonc with the
// ignored wrangler.local.jsonc (one deployment's account, routes and vars; see
// wrangler.local.example.jsonc) merged over it. Used by wrangler.mjs and
// setup.mjs.
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { experimental_readRawConfig } from "wrangler"

/** A path in apps/worker. */
export const workerPath = (file = "") =>
  fileURLToPath(new URL(`../${file}`, import.meta.url))

export const LOCAL_CONFIG = "wrangler.local.jsonc"

export const readConfig = (file) =>
  experimental_readRawConfig(
    { config: workerPath(file) },
    { useRedirectIfAvailable: false }
  ).rawConfig

/** Wrangler's own entry point, so scripts also run outside npm. */
export const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin/wrangler.js"
)

const isBindings = (value) =>
  Array.isArray(value) && value.every((entry) => entry?.binding)

// `vars` merge by name and binding arrays by `binding`; anything else in the
// local file replaces the shared value.
function merge(shared, local) {
  const config = { ...shared }
  for (const [key, value] of Object.entries(local)) {
    if (key === "vars") config.vars = { ...shared.vars, ...value }
    else if (isBindings(value) && isBindings(shared[key]))
      config[key] = [
        ...shared[key].map((entry) => ({
          ...entry,
          ...value.find((local) => local.binding === entry.binding),
        })),
        ...value.filter(
          (local) =>
            !shared[key].some((entry) => entry.binding === local.binding)
        ),
      ]
    else config[key] = value
  }
  return config
}

export function deploymentConfig() {
  const config = merge(
    readConfig("wrangler.jsonc"),
    existsSync(workerPath(LOCAL_CONFIG)) ? readConfig(LOCAL_CONFIG) : {}
  )
  // The Worker uses the account Wrangler deploys to, found the way Wrangler
  // finds it, so the account ID is written once.
  const account = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID
  if (account && !config.vars?.CLOUDFLARE_ACCOUNT_ID)
    config.vars = { ...config.vars, CLOUDFLARE_ACCOUNT_ID: account }
  return config
}
