import { defineConfig } from "vitest/config"

// Setup runs in Node on the maintainer's machine, outside the Worker runtime.
export default defineConfig({
  test: { environment: "node", include: ["scripts/**/*.test.mjs"] },
})
