import {
  clone,
  isDescendent,
  push,
  writeRef,
  type FsClient,
  type HttpClient,
} from "isomorphic-git"
import {
  RepositoryMovedError,
  requireCommit,
  type RepositoryAccess,
} from "./git"
import type { HeadReader } from "./smart-http"

export type { HttpClient as GitHttpClient } from "isomorphic-git"

export interface RepositoryPromotionInput {
  source: RepositoryAccess
  target: RepositoryAccess
  fromCommit: string
  toCommit: string
}

export type RepositoryPromoter = (
  input: RepositoryPromotionInput
) => Promise<void>

/** Only resource limits may fall back to native Git; never a rejected promotion. */
export class GitCapacityError extends Error {}

/** Pushes the exact reviewed commit, with the same guards as native Git promotion. */
export async function promoteFastForward(
  input: RepositoryPromotionInput,
  workspace: { fs: FsClient; http: HttpClient; dir: string },
  readHead: HeadReader
): Promise<void> {
  const { source, target, fromCommit, toCommit } = input
  requireCommit(fromCommit)
  requireCommit(toCommit)
  if (source.scope !== "read" || target.scope !== "write")
    throw new Error("Promotion requires source read and target write access")
  const head = await readHead(target)
  if (head === toCommit) return
  if (head !== fromCommit)
    throw new RepositoryMovedError(
      "Target repository moved; the candidate must be reviewed again"
    )
  const { fs, http, dir } = workspace
  const cache = {}
  await clone({
    fs,
    http,
    dir,
    url: source.remote,
    ref: source.branch,
    singleBranch: true,
    noCheckout: true,
    noTags: true,
    cache,
    onProgress: ({ total }) => {
      if (total > 20_000)
        throw new GitCapacityError("Git object count exceeds the Worker budget")
    },
  })
  if (
    !(await isDescendent({
      fs,
      dir,
      oid: toCommit,
      ancestor: fromCommit,
      cache,
    }))
  )
    throw new RepositoryMovedError(
      "Candidate is not a descendant of the target commit"
    )
  // A local ref selects exactly the reviewed commit, even if the source has
  // advanced since review. It is never a new commit and changes no history.
  const ref = "refs/heads/terminus-promotion"
  await writeRef({ fs, dir, ref, value: toCommit })
  try {
    await push({
      fs,
      http,
      dir,
      url: target.remote,
      ref,
      remoteRef: `refs/heads/${target.branch}`,
      force: false,
      cache,
      onPrePush: ({ localRef, remoteRef }) => {
        if (
          localRef.oid !== toCommit ||
          remoteRef.ref !== `refs/heads/${target.branch}` ||
          (remoteRef.oid !== fromCommit && remoteRef.oid !== toCommit)
        )
          throw new RepositoryMovedError(
            "Target moved during promotion; revalidate the candidate"
          )
        // receive-pack also checks this advertised old oid atomically.
        return true
      },
    })
  } catch (error) {
    const current = await readHead(target)
    if (current === toCommit) return
    if (current !== fromCommit)
      throw new RepositoryMovedError(
        "Target moved during promotion; revalidate the candidate"
      )
    throw error
  }
  if ((await readHead(target)) !== toCommit)
    throw new RepositoryMovedError("Target did not reach the accepted commit")
}
