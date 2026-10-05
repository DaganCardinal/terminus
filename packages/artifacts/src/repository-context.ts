import type { RepositoryContext } from "@terminus/protocol"
import {
  git,
  requireCommit,
  type GitWorkspace,
  type RepositoryAccess,
} from "./git"
import { isSecretPath } from "./repository-browse"

/** Inspect committed blobs with read-only Git access; never install or execute project code. */
export async function readRepositoryContext(
  workspace: GitWorkspace,
  access: RepositoryAccess,
  commit: string
): Promise<RepositoryContext> {
  requireCommit(commit)
  const directory = "/workspace/repo"
  await git(workspace, [
    "clone",
    "--no-checkout",
    "--",
    access.remote,
    directory,
  ])
  await git(workspace, ["cat-file", "-e", `${commit}^{commit}`], directory)
  const inventory = await git(
    workspace,
    ["ls-tree", "-r", "--format=%(objectmode) %(path)", "-z", commit],
    directory
  )
  const paths = inventory
    .split("\0")
    .filter((entry) => /^100(644|755) /.test(entry))
    .map((entry) => entry.slice(7))
    .filter((path) => !isSecretPath(path))
    .sort()
  const priority = [
    "AGENTS.md",
    "README.md",
    "package.json",
    "tsconfig.json",
    "src/App.tsx",
    "src/main.tsx",
    "src/index.ts",
  ]
  const candidates = [
    ...priority.filter((path) => paths.includes(path)),
    ...paths.filter(
      (path) =>
        /\.(tsx?|jsx?|css|md)$/.test(path) &&
        !/(\.test\.|\.spec\.|\.d\.ts$|(^|\/)(dist|vendor|node_modules)\/)/.test(
          path
        )
    ),
  ]
  const files: RepositoryContext["files"] = []
  for (const path of [...new Set(candidates)].slice(0, 12)) {
    const output = await workspace.run(
      ["git", "show", `${commit}:${path}`],
      directory
    )
    if (output.exitCode !== 0)
      throw new Error("Could not read planning context")
    if (output.stdout.includes("\0")) continue
    files.push({
      path,
      content: output.stdout.slice(0, 4000),
      truncated: output.stdout.length > 4000 || output.outputTruncated === true,
    })
  }
  return {
    commit,
    paths: paths.slice(0, 500),
    pathsTruncated: paths.length > 500,
    files,
  }
}
