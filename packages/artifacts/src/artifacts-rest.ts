import type {
  ArtifactsNamespaces,
  ArtifactsRepository,
  ArtifactsRepositoryInfo,
  ArtifactsService,
} from "./artifacts-repository-host"
import { requireCommit } from "./git"
import type { CommittedTreeEntry } from "./repository-browse"

/** Numeric Artifacts error codes, as the REST envelope reports them. */
const errorCodes: Record<number, string> = {
  10100: "INVALID_INPUT",
  10101: "INVALID_REPO_NAME",
  10103: "INVALID_TTL",
  10104: "INVALID_URL",
  10106: "REMOTE_AUTH_REQUIRED",
  10200: "NOT_FOUND",
  10201: "ALREADY_EXISTS",
  10302: "IMPORT_IN_PROGRESS",
  10303: "FORK_IN_PROGRESS",
  10400: "INTERNAL_ERROR",
  10401: "UPSTREAM_UNAVAILABLE",
  10402: "MEMORY_LIMIT",
}

/** An Artifacts failure with the same symbolic `code` the binding reports. */
export class ArtifactsApiError extends Error {
  readonly code: string
  readonly status: number
  /** The envelope's numeric code. Unlisted codes all map to `INTERNAL_ERROR`. */
  readonly apiCode: number | null
  /** The request's method and route shape, such as `POST /repos/:/fork`. */
  readonly operation: string | null
  /**
   * The envelope's message, only for codes this client does not recognise,
   * reduced to plain words so it is safe to log. Unlisted codes are what we
   * need to learn about.
   */
  readonly apiMessage: string | null
  constructor(
    status: number,
    code: string,
    message: string,
    detail: {
      apiCode?: number | null
      operation?: string | null
      apiMessage?: string | null
    } = {}
  ) {
    super(`ArtifactsError: ${message}`)
    this.name = "ArtifactsApiError"
    this.status = status
    this.code = code
    this.apiCode = detail.apiCode ?? null
    this.operation = detail.operation ?? null
    this.apiMessage = detail.apiMessage ?? null
  }
}

/** Long runs of word characters may be tokens or ids, so they are dropped. */
function loggableMessage(message: string): string | null {
  const words = message
    .replace(/[A-Za-z0-9_-]{24,}/g, "…")
    .replace(/[^A-Za-z0-9 .,:;'()/…-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
  return words || null
}

const routeWords = new Set([
  "repos",
  "tokens",
  "fork",
  "import",
  "commit",
  "tree",
  "blob",
])

/** A request's route without namespace, repository or object names. */
function operation(method: string, path: string): string {
  const route = path
    .split("?")[0]!
    .split("/")
    .slice(2)
    .map((part) => (routeWords.has(part) ? part : ":"))
  return `${method} /${route.join("/")}`
}

interface Envelope<T> {
  result: T | null
  success: boolean
  errors: { code: number; message: string }[]
  result_info?: { cursor?: string; has_more?: boolean }
}

interface RepoWithRemote {
  name: string
  description: string | null
  default_branch: string
  remote: string
}

/**
 * Artifacts over its REST API. Unlike the Workers binding, which is fixed to
 * one namespace at deploy time, this reaches any namespace, so each Project can
 * own one. The API token is an account credential: it stays in the Worker and
 * never reaches a Sandbox, which only ever receives short-lived repo tokens.
 */
export class ArtifactsRestClient implements ArtifactsNamespaces {
  private readonly base: string
  private readonly apiToken: string
  private readonly fetch: typeof fetch
  constructor(input: {
    accountId: string
    apiToken: string
    fetch?: typeof fetch
  }) {
    if (!input.accountId || !input.apiToken)
      throw new Error(
        "Artifacts needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_RUNTIME_TOKEN"
      )
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/artifacts/namespaces`
    this.apiToken = input.apiToken
    this.fetch = input.fetch ?? ((...args) => fetch(...args))
  }

  async ensure(namespace: string): Promise<void> {
    try {
      await this.request("POST", "", { namespace })
    } catch (error) {
      // Creating is idempotent here: the namespace may already exist from an
      // earlier attempt to onboard the same Project.
      if (
        !(error instanceof ArtifactsApiError) ||
        (error.code !== "ALREADY_EXISTS" && error.status !== 409)
      )
        throw error
    }
  }

  /** Delete every repository, including candidates that were never recorded
   * after a failed fork. The namespace belongs exclusively to one Network. */
  async deleteRepositories(namespace: string): Promise<void> {
    const at = `/${encodeURIComponent(namespace)}/repos`
    const names: string[] = []
    let cursor: string | undefined
    do {
      let page: Envelope<{ name: string }[]>
      try {
        page = await this.requestEnvelope(
          "GET",
          `${at}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        )
      } catch (error) {
        if (error instanceof ArtifactsApiError && error.code === "NOT_FOUND")
          return
        throw error
      }
      names.push(...page.result!.map((repo) => repo.name))
      const next = page.result_info?.cursor
      if (page.result_info?.has_more && (!next || next === cursor))
        throw new Error("Artifacts repository pagination did not advance")
      cursor = page.result_info?.has_more === false ? undefined : next
    } while (cursor)
    for (const name of names) {
      try {
        await this.request("DELETE", `${at}/${encodeURIComponent(name)}`)
      } catch (error) {
        if (!(error instanceof ArtifactsApiError) || error.code !== "NOT_FOUND")
          throw error
      }
    }
  }

  namespace(namespace: string): ArtifactsService {
    const at = `/${encodeURIComponent(namespace)}`
    const repo = (name: string) => `${at}/repos/${encodeURIComponent(name)}`
    // Tokens are addressed by id within the namespace, not the repository.
    const revokeById = async (id: string) => {
      try {
        await this.request("DELETE", `${at}/tokens/${encodeURIComponent(id)}`)
        return true
      } catch (error) {
        if (error instanceof ArtifactsApiError && error.code === "NOT_FOUND")
          return false
        throw error
      }
    }
    const handle = (
      name: string,
      fetched: ArtifactsRepositoryInfo
    ): ArtifactsRepository => ({
      [Symbol.dispose]: () => {},
      // `get` just read the repository; reading it again costs a round trip.
      info: async () => fetched,
      createToken: async (scope, ttl) => {
        const token = await this.request<{ id: string; plaintext: string }>(
          "POST",
          `${at}/tokens`,
          { repo: name, scope, ttl }
        )
        return { id: token.id, plaintext: token.plaintext }
      },
      revokeToken: async (tokenOrId) => {
        const id = isPlaintext(tokenOrId)
          ? await this.initialTokenId(repo(name), tokenOrId)
          : tokenOrId
        return id ? revokeById(id) : false
      },
      delete: async () => {
        try {
          await this.request("DELETE", repo(name))
        } catch (error) {
          if (
            !(error instanceof ArtifactsApiError) ||
            error.code !== "NOT_FOUND"
          )
            throw error
        }
      },
      fork: async (target, options) => {
        const created = await this.request<{ token: string }>(
          "POST",
          `${repo(name)}/fork`,
          {
            name: target,
            description: options.description,
            default_branch_only: options.defaultBranchOnly,
          }
        )
        return { token: created.token }
      },
    })
    return {
      get: async (name) => {
        // Resolve now so missing or still-importing repos fail here, as the
        // binding's get() does.
        return handle(name, info(await this.request("GET", repo(name))))
      },
      revokeToken: revokeById,
      create: async (name, options) => {
        const created = await this.request<{ token: string }>(
          "POST",
          `${at}/repos`,
          {
            name,
            description: options.description,
            default_branch: options.setDefaultBranch,
          }
        )
        return { token: created.token }
      },
      import: async (input) => {
        const created = await this.request<{ token: string }>(
          "POST",
          `${repo(input.target.name)}/import`,
          { url: input.source.url }
        )
        return { token: created.token }
      },
      // Commits, trees and blobs are immutable, so reads by hash never race a push.
      objects: (name) => ({
        treeOf: async (commit) =>
          (
            await this.request<{ treeHash: string }>(
              "GET",
              `${repo(name)}/commit/${requireCommit(commit)}`
            )
          ).treeHash,
        tree: async (hash) =>
          this.request<CommittedTreeEntry[]>(
            "GET",
            `${repo(name)}/tree/${objectHash(hash)}`
          ),
        blobSize: async (hash) => {
          const length = (
            await this.raw("HEAD", `${repo(name)}/blob/${objectHash(hash)}`)
          ).headers.get("content-length")
          if (!length || !/^\d+$/.test(length))
            throw new Error("Artifacts did not report the blob size")
          return Number(length)
        },
        blob: async (hash) => {
          const response = await this.raw(
            "GET",
            `${repo(name)}/blob/${objectHash(hash)}`
          )
          if (!response.body) throw new Error("Artifacts returned no blob")
          return response.body
        },
      }),
    }
  }

  /**
   * Create, fork, and import return only a token's plaintext, while REST
   * revokes by id. The plaintext carries its expiry, so match it against the
   * repository's active tokens.
   */
  private async initialTokenId(
    repoPath: string,
    plaintext: string
  ): Promise<string | null> {
    const expires = Number(
      new URL(plaintext, "https://token.invalid").searchParams.get("expires")
    )
    if (!Number.isInteger(expires) || expires <= 0) return null
    const tokens = await this.request<{ id: string; expires_at: string }[]>(
      "GET",
      `${repoPath}/tokens?state=active&per_page=100`
    )
    const matches = tokens.filter(
      (token) => Math.floor(Date.parse(token.expires_at) / 1000) === expires
    )
    return matches.length === 1 ? matches[0]!.id : null
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    return (await this.requestEnvelope<T>(method, path, body)).result!
  }

  private async requestEnvelope<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Envelope<T>> {
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const envelope = (await response
      .json()
      .catch(() => null)) as Envelope<T> | null
    if (response.ok && envelope?.success && envelope.result !== null)
      return envelope
    throw failure(response.status, envelope, operation(method, path))
  }

  /** A successful response whose body is raw bytes rather than an envelope. */
  private async raw(method: "GET" | "HEAD", path: string): Promise<Response> {
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiToken}` },
    })
    if (response.ok) return response
    // Errors still arrive as envelopes, except to HEAD, which has no body.
    const envelope = (await response
      .json()
      .catch(() => null)) as Envelope<unknown> | null
    throw failure(response.status, envelope, operation(method, path))
  }
}

function failure(
  status: number,
  envelope: Envelope<unknown> | null,
  operation: string
): ArtifactsApiError {
  const first = envelope?.errors?.[0]
  const known = first ? errorCodes[first.code] : undefined
  const code = known ?? (status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR")
  return new ArtifactsApiError(
    status,
    code,
    first?.message ?? `Artifacts request failed (${status})`,
    {
      apiCode: typeof first?.code === "number" ? first.code : null,
      operation,
      apiMessage:
        !known && typeof first?.message === "string"
          ? loggableMessage(first.message)
          : null,
    }
  )
}

/** Tree and blob hashes come from Artifacts responses, but still form URL paths. */
function objectHash(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value))
    throw new Error("Expected a full Git object hash")
  return value
}

function info(repo: unknown): ArtifactsRepositoryInfo {
  const value = repo as RepoWithRemote
  return {
    name: value.name,
    remote: value.remote,
    defaultBranch: value.default_branch,
    description: value.description,
  }
}

function isPlaintext(tokenOrId: string): boolean {
  return tokenOrId.startsWith("art_")
}
