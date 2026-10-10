import { requireCommit, type RepositoryAccess } from "./git"

/** Reads a repository's default-branch head without a workspace; null when it has none. */
export type HeadReader = (access: RepositoryAccess) => Promise<string | null>

const advertisement = "application/x-git-upload-pack-advertisement"

/**
 * Reads the head from Git's smart-HTTP ref advertisement over `fetch`: the
 * same answer as `git ls-remote`, without starting a Sandbox to run Git.
 */
export function smartHttpHeadReader(
  send: typeof fetch = (...args) => fetch(...args)
): HeadReader {
  return async (access) => {
    const url = new URL(access.remote)
    if (url.protocol !== "https:" || url.username || url.password || url.search)
      throw new Error("Unsupported Git remote")
    url.pathname = `${url.pathname.replace(/\/$/, "")}/info/refs`
    url.search = "?service=git-upload-pack"
    const response = await send(url, {
      headers: {
        authorization: `Bearer ${access.token}`,
        "user-agent": "git/terminus",
      },
      redirect: "manual",
    })
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith(advertisement)
    ) {
      await response.body?.cancel()
      throw new Error(`Git ref discovery failed (${response.status})`)
    }
    return advertisedHead(
      new Uint8Array(await response.arrayBuffer()),
      `refs/heads/${access.branch}`
    )
  }
}

/** The commit an upload-pack (v0/v1) advertisement lists for `ref`, or null when it lists none. */
export function advertisedHead(body: Uint8Array, ref: string): string | null {
  const decoder = new TextDecoder()
  let head: string | null = null
  for (let at = 0; at < body.length;) {
    const prefix = decoder.decode(body.subarray(at, at + 4))
    if (!/^[0-9a-f]{4}$/.test(prefix))
      throw new Error("Malformed Git ref advertisement")
    const length = Number.parseInt(prefix, 16)
    if (length === 0) {
      at += 4
      continue
    }
    if (length < 4 || at + length > body.length)
      throw new Error("Malformed Git ref advertisement")
    const line = decoder.decode(body.subarray(at + 4, at + length))
    at += length
    if (line.startsWith("#")) continue
    const [hash, name] = line.replace(/\n$/, "").split("\0")[0]!.split(" ")
    if (name === ref) head = requireCommit(hash ?? "")
  }
  return head
}
