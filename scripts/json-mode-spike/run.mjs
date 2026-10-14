// Runs spike.ts. esbuild bundles it with the workspace TypeScript packages it
// imports, which plain Node cannot resolve.
import { build } from "esbuild"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outfile = join(tmpdir(), `json-mode-spike-${process.pid}.mjs`)
await build({
  entryPoints: [join(here, "spike.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile,
  logLevel: "warning",
})
try {
  const { main } = await import(pathToFileURL(outfile).href)
  await main(here)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await rm(outfile, { force: true })
}
// A read blocked on a locked secrets pipe would otherwise keep Node running.
process.exit()
