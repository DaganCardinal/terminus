import type {
  ArtifactsNamespaces,
  ArtifactsRepository,
  ArtifactsRepositoryInfo,
  ArtifactsService,
} from "./artifacts-repository-host"

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
  constructor(status: number, code: string, message: string) {
    super(`ArtifactsError: ${message}`)
    this.name = "ArtifactsApiError"
    this.status = status
    this.code = code
  }
}

interface Envelope<T> {
  result: T | null
  success: boolean
  errors: { code: number; message: string }[]
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
        "Artifacts needs ARTIFACTS_ACCOUNT_ID and ARTIFACTS_API_TOKEN"
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

  namespace(namespace: string): ArtifactsService {
    const at = `/${encodeURIComponent(namespace)}`
    const repo = (name: string) => `${at}/repos/${encodeURIComponent(name)}`
    const handle = (name: string): ArtifactsRepository => ({
      [Symbol.dispose]: () => {},
      info: async () => info(await this.request("GET", repo(name))),
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
        if (!id) return false
        try {
          await this.request("DELETE", `${at}/tokens/${encodeURIComponent(id)}`)
          return true
        } catch (error) {
          if (error instanceof ArtifactsApiError && error.code === "NOT_FOUND")
            return false
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
        await this.request("GET", repo(name))
        return handle(name)
      },
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
      return envelope.result
    const first = envelope?.errors?.[0]
    const code =
      (first && errorCodes[first.code]) ??
      (response.status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR")
    throw new ArtifactsApiError(
      response.status,
      code,
      first?.message ?? `Artifacts request failed (${response.status})`
    )
  }
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
