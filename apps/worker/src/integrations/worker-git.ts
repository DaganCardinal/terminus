import * as fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import {
  GitCapacityError,
  promoteFastForward,
  type HeadReader,
  type GitHttpClient,
  type RepositoryAccess,
  type RepositoryPromoter,
} from "@terminus/artifacts"

/** Leaves room for indexing and packing within the Worker's in-memory filesystem. */
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024

/** Git over fetch, restricted to the two granted repositories and their scopes. */
export function promotionHttp(
  accesses: RepositoryAccess[],
  send: typeof fetch = (...args) => fetch(...args),
  maxBytes = MAX_TRANSFER_BYTES
): GitHttpClient {
  return {
    request: async ({ url, method = "GET", headers, body, signal }) => {
      const requested = new URL(url)
      const access = accesses.find(({ remote, scope }) => {
        const base = new URL(remote)
        if (
          base.protocol !== "https:" ||
          base.username ||
          base.password ||
          base.search ||
          base.hash
        )
          throw new Error("Unsupported Git remote")
        const path = base.pathname.replace(/\/$/, "")
        if (
          requested.origin !== base.origin ||
          requested.username ||
          requested.password ||
          requested.hash
        )
          return false
        const service =
          method === "GET" && requested.pathname === `${path}/info/refs`
            ? requested.searchParams.get("service")
            : method === "POST" && !requested.search
              ? requested.pathname.slice(path.length + 1)
              : null
        return (
          (method === "GET" || requested.pathname === `${path}/${service}`) &&
          (service === "git-upload-pack" ||
            (scope === "write" && service === "git-receive-pack"))
        )
      })
      if (!access)
        throw new Error("Git request is outside the promotion grants")
      const trustedHeaders = new Headers(headers)
      trustedHeaders.set("authorization", `Bearer ${access.token}`)
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (body) {
        for await (const chunk of body) {
          bytes += chunk.byteLength
          if (bytes > maxBytes)
            throw new GitCapacityError("Git upload exceeds the Worker budget")
          chunks.push(chunk)
        }
      }
      const payload = new Uint8Array(bytes)
      let at = 0
      for (const chunk of chunks) {
        payload.set(chunk, at)
        at += chunk.byteLength
      }
      const response = await send(url, {
        method,
        headers: trustedHeaders,
        ...(body ? { body: payload } : {}),
        signal,
        redirect: "manual",
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Git HTTP request failed (${response.status})`)
      }
      const length = Number(response.headers.get("content-length"))
      if (length > maxBytes) {
        await response.body?.cancel()
        throw new GitCapacityError("Git download exceeds the Worker budget")
      }
      return {
        url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: readGitBody(response.body, maxBytes),
      }
    },
  }
}

async function* readGitBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
) {
  if (!body) return
  const reader = body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      bytes += value.byteLength
      if (bytes > maxBytes)
        throw new GitCapacityError("Git download exceeds the Worker budget")
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Disposable Worker-local Git storage; accepted state stays in Artifacts. */
export function workerGitPromotion(
  readHead: HeadReader,
  send: typeof fetch = (...args) => fetch(...args)
): RepositoryPromoter {
  return async (input) => {
    const dir = await mkdtemp("/tmp/terminus-promotion-")
    try {
      await promoteFastForward(
        input,
        { fs, dir, http: promotionHttp([input.source, input.target], send) },
        readHead
      )
    } finally {
      // Workers does not support rm's force option. mkdtemp created this path.
      await rm(dir, { recursive: true })
    }
  }
}
