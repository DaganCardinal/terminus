import { git, type GitWorkspace } from "./git"

/** `isSecretPath` as Git globs; `secret-diff.test.ts` checks that both select the same files. */
const secretGlobs = [
  "**/.env*",
  "**/.dev.vars*",
  "**/credentials*",
  "**/*.pem",
  "**/*.key",
]

/** Pathspecs that keep secret files out of a Git diff, so their contents never leave Git. */
export const withoutSecrets = secretGlobs.map(
  (glob) => `:(exclude,glob,icase)${glob}`
)

const onlySecrets = secretGlobs.map((glob) => `:(glob,icase)${glob}`)

const NULL_MODE = "000000"

/** Git never compares a regular file, a symlink and a submodule with each other. */
export function fileKind(mode: string): "file" | "symlink" | "submodule" {
  if (mode === "160000") return "submodule"
  return mode === "120000" ? "symlink" : "file"
}

/**
 * A changed secret file's entry in a patch: its path and modes, never its
 * contents or object IDs, since an object ID can confirm a guessed secret.
 */
export function secretFilePatch(
  path: string,
  before: { mode: string; hash: string } | undefined,
  after: { mode: string; hash: string } | undefined
): string {
  // Like Git, a path that changed kind is a deletion followed by an addition.
  if (before && after && fileKind(before.mode) !== fileKind(after.mode))
    return (
      secretFilePatch(path, before, undefined) +
      secretFilePatch(path, undefined, after)
    )
  const lines = [`diff --git a/${path} b/${path}`]
  if (!before) lines.push(`new file mode ${after!.mode}`)
  else if (!after) lines.push(`deleted file mode ${before.mode}`)
  else if (before.mode !== after.mode)
    lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`)
  if (before?.hash !== after?.hash) lines.push("Secret file contents withheld")
  return `${lines.join("\n")}\n`
}

/**
 * The patch entries of secret files changed between two commits or trees.
 * `git diff --raw` reports their modes without reading their contents.
 */
export async function secretFilePatches(
  workspace: GitWorkspace,
  base: string,
  head: string,
  cwd: string
): Promise<string> {
  const fields = (
    await git(
      workspace,
      [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-abbrev",
        base,
        head,
        "--",
        ...onlySecrets,
      ],
      cwd
    )
  ).split("\0")
  let patches = ""
  // Each entry is `:<old mode> <new mode> <old id> <new id> <status>`, then its path.
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [oldMode, newMode, oldId, newId] = fields[at]!.slice(1).split(" ")
    if (!oldMode || !newMode || !oldId || !newId)
      throw new Error("Unexpected Git raw diff entry")
    patches += secretFilePatch(
      fields[at + 1]!,
      oldMode === NULL_MODE ? undefined : { mode: oldMode, hash: oldId },
      newMode === NULL_MODE ? undefined : { mode: newMode, hash: newId }
    )
  }
  return patches
}
