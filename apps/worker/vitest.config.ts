import { join } from "node:path"
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    join(import.meta.dirname, "migrations")
  )
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "fake" },
        miniflare: {
          durableObjects: {
            SANDBOX: "ExecutionSandbox",
            WORKSPACE_SANDBOX: "WorkspaceSandbox",
            SANDBOX_STANDARD_1: "ExecutionSandboxStandard1",
            SANDBOX_STANDARD_2: "ExecutionSandboxStandard2",
            SANDBOX_STANDARD_3: "ExecutionSandboxStandard3",
            WORKSPACE_SANDBOX_STANDARD_1: "WorkspaceSandboxStandard1",
            WORKSPACE_SANDBOX_STANDARD_2: "WorkspaceSandboxStandard2",
            WORKSPACE_SANDBOX_STANDARD_3: "WorkspaceSandboxStandard3",
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            FAKE_AGENT_DELAY_MS: "0",
            DISPATCHER_MODEL: "fake",
            APP_ORIGIN: "https://terminus.test",
          },
        },
      }),
    ],
    test: {
      exclude: [...configDefaults.exclude, "scripts/**"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  }
})
