import { git, type GitWorkspace, type RepositoryAccess } from "./git"
import { IntegrationGit } from "./integration-git"
import { isSecretPath } from "./repository-browse"

/** Where a harness role explores a sealed checkout of one exact commit. */
export const sealedDirectory = "/workspace/repo"

/** Outside the checkout, so the agent working there does not see it as project content. */
const fingerprintPath = "/workspace/sealed-fingerprint.json"

/** A detached checkout of the exact commit a read-only role works against. */
export async function checkoutSealedWorkspace(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string
): Promise<void> {
  await new IntegrationGit(workspace, access, commit).checkout()
}

/**
 * Hashes every tracked file that is still present (`record`), or reports which
 * of them changed since (`compare`). Symlinks are compared by target and never
 * followed.
 */
const fingerprintScript = `const fs = require("node:fs")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const [mode, file] = process.argv.slice(1)
const digest = (path) => {
  let stat
  try { stat = fs.lstatSync(path) } catch { return null }
  if (stat.isSymbolicLink()) return "link:" + fs.readlinkSync(path)
  if (!stat.isFile()) return "other"
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")
}
if (mode === "record") {
  const tracked = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 }).toString().split("\\0").filter(Boolean)
  const files = {}
  for (const path of tracked) {
    const value = digest(path)
    if (value !== null) files[path] = value
  }
  fs.writeFileSync(file, JSON.stringify(files))
} else {
  const files = JSON.parse(fs.readFileSync(file, "utf8"))
  const changed = Object.keys(files).filter((path) => digest(path) !== files[path])
  console.log(JSON.stringify({ count: changed.length, paths: changed.slice(0, 20) }))
}
`

/**
 * Removes committed secrets and Git history before a model can read the
 * checkout. History objects would otherwise still contain the secret blobs.
 * With `fingerprint`, the remaining tracked files are recorded first, so
 * `changedSinceSeal` can show that a role which runs commands left them as
 * they were.
 */
export async function sealWorkspace(
  workspace: GitWorkspace,
  options: { fingerprint?: boolean } = {}
): Promise<void> {
  const secrets = (await git(workspace, ["ls-files", "-z"], sealedDirectory))
    .split("\0")
    .filter((path) => path && isSecretPath(path))
  for (let i = 0; i < secrets.length; i += 100) {
    const removed = await workspace.run(
      ["rm", "-f", "--", ...secrets.slice(i, i + 100)],
      sealedDirectory
    )
    if (removed.exitCode !== 0)
      throw new Error("Could not remove secret files from the sealed checkout")
  }
  if (options.fingerprint) {
    const recorded = await workspace.run(
      ["node", "-e", fingerprintScript, "record", fingerprintPath],
      sealedDirectory
    )
    if (recorded.exitCode !== 0)
      throw new Error("Could not fingerprint the sealed checkout")
  }
  const history = await workspace.run(
    ["rm", "-rf", "--", ".git"],
    sealedDirectory
  )
  if (history.exitCode !== 0)
    throw new Error("Could not remove history from the sealed checkout")
}

/** Tracked files that changed since `sealWorkspace` fingerprinted them (at most twenty listed). */
export async function changedSinceSeal(
  workspace: GitWorkspace
): Promise<{ count: number; paths: string[] }> {
  const result = await workspace.run(
    ["node", "-e", fingerprintScript, "compare", fingerprintPath],
    sealedDirectory
  )
  if (result.exitCode !== 0 || result.outputTruncated)
    throw new Error(
      "Could not compare the sealed checkout with its fingerprint"
    )
  const parsed = JSON.parse(result.stdout) as unknown
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("count" in parsed) ||
    typeof parsed.count !== "number" ||
    !("paths" in parsed) ||
    !Array.isArray(parsed.paths)
  )
    throw new Error("Sealed checkout comparison returned an unexpected result")
  return { count: parsed.count, paths: parsed.paths.map(String) }
}
