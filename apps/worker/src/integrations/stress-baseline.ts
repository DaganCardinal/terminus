import lockfile from "./stress-baseline-lock.txt"

/** Bundled, small npm Project: no Git URL, manual push, or user's source tree needed. */
export const stressBaselineFiles: Record<string, string> = {
  "package.json":
    JSON.stringify(
      {
        name: "terminus-stress-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
        engines: { node: ">=24" },
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "tsc --outDir dist",
        },
        devDependencies: { typescript: "~6.0.2", vitest: "^4.1.11" },
      },
      null,
      2
    ) + "\n",
  "package-lock.json": lockfile,
  "tsconfig.json":
    JSON.stringify(
      {
        compilerOptions: {
          rootDir: "src",
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2
    ) + "\n",
  ".gitignore": "node_modules/\ndist/\n",
  ".nvmrc": "24\n",
  "README.md":
    "# Terminus stress fixture\n\nTen concurrent Trains add independent checkpoint modules and tests. Run npm ci, npm test, npm run typecheck, and npm run build.\n",
  "src/baseline.ts": 'export const baseline = "terminus"\n',
  "src/baseline.test.ts":
    'import { expect, it } from "vitest"\nimport { baseline } from "./baseline"\nit("retains the baseline", () => { expect(baseline).toBe("terminus") })\n',
}
