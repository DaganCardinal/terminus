// Runs Wrangler with this deployment's values. wrangler.jsonc is the shared
// configuration; the ignored wrangler.local.jsonc holds one deployment's
// account, routes and vars (see wrangler.local.example.jsonc). Without it,
// Wrangler runs against wrangler.jsonc unchanged.
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { experimental_readRawConfig } from "wrangler"

const path = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url))
const read = (file) =>
  experimental_readRawConfig(
    { config: path(file) },
    { useRedirectIfAvailable: false }
  ).rawConfig

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

let config = path("wrangler.jsonc")
if (existsSync(path("wrangler.local.jsonc"))) {
  // Beside wrangler.jsonc, so its relative paths still resolve.
  config = path("wrangler.generated.json")
  writeFileSync(
    config,
    JSON.stringify(
      merge(read("wrangler.jsonc"), read("wrangler.local.jsonc")),
      null,
      2
    )
  )
}

// Wrangler's own entry point, so this also runs outside npm scripts.
const wrangler = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin/wrangler.js"
)
const { status, error } = spawnSync(
  process.execPath,
  [wrangler, ...process.argv.slice(2), "--config", config],
  { stdio: "inherit" }
)
if (error) throw error
process.exit(status ?? 1)
