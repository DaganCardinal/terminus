import {
  git,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"

// Neither script follows symlinks, including those introduced by install scripts.
const writeScript = `const fs = require("node:fs"); const path = require("node:path");
  const files = JSON.parse(process.argv[1]);
  for (const [file, contents] of Object.entries(files)) {
    let current = process.cwd();
    for (const part of file.split("/").slice(0, -1)) {
      current = path.join(current, part);
      try { if (!fs.lstatSync(current).isDirectory()) throw new Error("Unsafe stress directory"); }
      catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(current); }
    }
    let existing;
    try { existing = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!existing) { fs.writeFileSync(file, contents, { flag: "wx" }); continue; }
    // A revision starts from the earlier candidate, which already holds these exact files.
    if (!existing.isFile() || fs.readFileSync(file, "utf8") !== contents)
      throw new Error("Unexpected existing stress file: " + file);
  }`

const checkScript = `const fs = require("node:fs"); const path = require("node:path");
  for (const [file, contents] of Object.entries(JSON.parse(process.argv[1]))) {
    let current = process.cwd();
    for (const part of file.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink in stress candidate");
    }
    if (fs.readFileSync(file, "utf8") !== contents) throw new Error("Incorrect stress checkpoint");
  }`

/** Writes the fixture's files into a checkout; rerunning over identical files is a no-op. */
export async function writeStressFiles(
  workspace: GitWorkspace,
  files: Record<string, string>,
  directory: string
): Promise<void> {
  const result = await workspace.run(
    ["node", "-e", writeScript, JSON.stringify(files)],
    directory
  )
  if (result.exitCode !== 0) throw new Error("Scripted stress edit failed")
}

/** Confirms a checkout holds exactly the fixture's file contents, without symlinks. */
export async function checkStressFiles(
  workspace: GitWorkspace,
  files: Record<string, string>,
  directory: string
): Promise<void> {
  const result = await workspace.run(
    ["node", "-e", checkScript, JSON.stringify(files)],
    directory
  )
  if (result.exitCode !== 0)
    throw new Error("Stress candidate failed independent fixture verification")
}

/** The canonical repository differs from the scenario; every difference is listed. */
export class StressGitMismatchError extends Error {
  readonly findings: string[]
  constructor(findings: string[]) {
    super(findings.join("; "))
    this.name = "StressGitMismatchError"
    this.findings = findings
  }
}

function listed(label: string, values: string[]): string {
  const shown = values.slice(0, 10).join(", ")
  return `${label}: ${shown}${values.length > 10 ? `, and ${values.length - 10} more` : ""}`
}

/** Read-only final oracle, using canonical Git objects rather than agent summaries. */
export async function verifyStressGit(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  input: {
    baseline: string
    head: string
    files: Record<string, string>
    acceptedCommits: string[]
    integrationCommits: string[]
  }
): Promise<{
  commit: string
  files: number
  reachableCars: number
  mergeCommits: string[]
}> {
  const baseline = requireCommit(input.baseline)
  const head = requireCommit(input.head)
  const commits = input.acceptedCommits.map(requireCommit)
  const integrations = input.integrationCommits.map(requireCommit)
  for (const path of Object.keys(input.files))
    if (
      !/^src\/terminus-stress\/[a-f0-9-]+\/train-\d{2}(\.test)?\.ts$/.test(path)
    )
      throw new Error("Invalid stress oracle path")
  const directory = "/workspace/stress-oracle"
  /** Where a recorded commit stands relative to the canonical head. */
  const reach = async (commit: string) => {
    const present = await workspace.run(
      ["git", "cat-file", "-e", `${commit}^{commit}`],
      directory
    )
    if (present.exitCode !== 0)
      return "is missing from the canonical repository"
    const result = await workspace.run(
      ["git", "merge-base", "--is-ancestor", commit, head],
      directory
    )
    if (result.exitCode > 1)
      throw new Error(`Git merge-base failed (exit ${result.exitCode})`)
    return result.exitCode === 0
      ? null
      : "is not reachable from the canonical head"
  }
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    access.remote,
    directory,
  ])
  const actualHead = (
    await git(workspace, ["rev-parse", "HEAD"], directory)
  ).trim()
  // Every later check reads the recorded head, so a moved head ends the comparison.
  if (actualHead !== head)
    throw new StressGitMismatchError([
      `Canonical Git head ${actualHead} differs from the recorded snapshot head ${head}`,
    ])
  // The file and merge comparisons are relative to the baseline.
  const base = await reach(baseline)
  if (base)
    throw new StressGitMismatchError([`Frozen baseline ${baseline} ${base}`])
  const findings: string[] = []
  const paths = new Set(
    (
      await git(
        workspace,
        ["diff", "--name-only", "-z", baseline, head],
        directory
      )
    )
      .split("\0")
      .filter(Boolean)
  )
  const expected = Object.keys(input.files).sort()
  const missing = expected.filter((path) => !paths.has(path))
  const unexpected = [...paths].filter((path) => !(path in input.files)).sort()
  if (missing.length)
    findings.push(listed("Canonical changes are missing stress files", missing))
  if (unexpected.length)
    findings.push(
      listed("Canonical changes include files outside the fixture", unexpected)
    )
  for (const path of expected) {
    if (!paths.has(path)) continue
    const entry = await git(workspace, ["ls-tree", head, "--", path], directory)
    if (!entry.startsWith("100644 blob ")) {
      findings.push(`Stress file is not a regular blob: ${path}`)
      continue
    }
    if (
      (await git(workspace, ["show", `${head}:${path}`], directory)) !==
      input.files[path]
    )
      findings.push(`Incorrect canonical stress file: ${path}`)
  }
  if (new Set(commits).size !== commits.length)
    findings.push("Duplicate accepted stress commits")
  for (const commit of commits) {
    const problem = await reach(commit)
    if (problem) findings.push(`Accepted Car commit ${commit} ${problem}`)
  }
  const mergeCommits = (
    await git(
      workspace,
      ["rev-list", "--min-parents=2", `${baseline}..${head}`],
      directory
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean)
  if (new Set(integrations).size !== integrations.length)
    findings.push("Duplicate recorded integration commits")
  const unrecorded = mergeCommits.filter((c) => !integrations.includes(c))
  const absent = integrations.filter((c) => !mergeCommits.includes(c))
  if (absent.length)
    findings.push(
      listed("Recorded integration commits are not canonical merges", absent)
    )
  if (unrecorded.length)
    findings.push(
      listed(
        "Canonical merges do not match any unloaded Train's record",
        unrecorded
      )
    )
  if (mergeCommits.length !== 10)
    findings.push(
      `Expected exactly ten canonical merge commits, found ${mergeCommits.length}`
    )
  if (findings.length) throw new StressGitMismatchError(findings)
  return {
    commit: head,
    files: paths.size,
    reachableCars: commits.length,
    mergeCommits,
  }
}
