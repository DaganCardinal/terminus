import {
  git,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"

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
  const directory = "/workspace/stress-oracle"
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    access.remote,
    directory,
  ])
  if ((await git(workspace, ["rev-parse", "HEAD"], directory)).trim() !== head)
    throw new Error(
      "Canonical Git head differs from its recorded stress snapshot"
    )
  await git(
    workspace,
    ["merge-base", "--is-ancestor", baseline, head],
    directory
  )
  const paths = (
    await git(
      workspace,
      ["diff", "--name-only", "-z", baseline, head],
      directory
    )
  )
    .split("\0")
    .filter(Boolean)
    .sort()
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(input.files).sort()))
    throw new Error(
      "Canonical changes differ from the expected stress file inventory"
    )
  for (const [path, contents] of Object.entries(input.files)) {
    if (
      !/^src\/terminus-stress\/[a-f0-9-]+\/train-\d{2}(\.test)?\.ts$/.test(path)
    )
      throw new Error("Invalid stress oracle path")
    const entry = await git(workspace, ["ls-tree", head, "--", path], directory)
    if (!entry.startsWith("100644 blob "))
      throw new Error(`Stress file is not a regular blob: ${path}`)
    if (
      (await git(workspace, ["show", `${head}:${path}`], directory)) !==
      contents
    )
      throw new Error(`Incorrect canonical stress file: ${path}`)
  }
  if (new Set(commits).size !== commits.length)
    throw new Error("Duplicate accepted stress commits")
  for (const commit of commits)
    await git(
      workspace,
      ["merge-base", "--is-ancestor", commit, head],
      directory
    )
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
  if (
    new Set(integrations).size !== 10 ||
    JSON.stringify([...integrations].sort()) !==
      JSON.stringify([...mergeCommits].sort())
  )
    throw new Error("Canonical merges differ from unloaded Train provenance")
  if (mergeCommits.length !== 10)
    throw new Error("Expected exactly ten canonical merge commits")
  return {
    commit: head,
    files: paths.length,
    reachableCars: commits.length,
    mergeCommits,
  }
}
