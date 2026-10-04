import { join } from "node:path"
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    join(import.meta.dirname, "migrations")
  )
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "fake" },
        miniflare: {
          durableObjects: { SANDBOX: "ExecutionSandbox" },
          bindings: {
            TEST_MIGRATIONS: migrations,
            FAKE_AGENT_DELAY_MS: "0",
            DISPATCHER_MODEL: "fake",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  }
})
