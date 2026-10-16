// Runs Wrangler with this deployment's values: wrangler.jsonc with the ignored
// wrangler.local.jsonc merged over it (see config.mjs). Without a local file,
// Wrangler runs against wrangler.jsonc plus the account's CLOUDFLARE_ACCOUNT_ID.
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { deploymentConfig, workerPath, wranglerBin } from "./config.mjs"

// Beside wrangler.jsonc, so its relative paths still resolve.
const config = workerPath("wrangler.generated.json")
writeFileSync(config, JSON.stringify(deploymentConfig(), null, 2))

const { status, error } = spawnSync(
  process.execPath,
  [wranglerBin, ...process.argv.slice(2), "--config", config],
  { stdio: "inherit" }
)
if (error) throw error
process.exit(status ?? 1)
