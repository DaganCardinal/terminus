import { describe, expect, it } from "vitest"
import { ArtifactsApiError, ArtifactsRestClient } from "./artifacts-rest"

const base =
  "https://api.cloudflare.com/client/v4/accounts/acct/artifacts/namespaces"

function client(
  respond: (
    method: string,
    path: string,
    body: unknown
  ) => {
    status?: number
    result?: unknown
    errors?: unknown[]
    result_info?: unknown
  }
) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const rest = new ArtifactsRestClient({
    accountId: "acct",
    apiToken: "api-secret",
    fetch: async (input, init) => {
      const url = String(input)
      expect(url.startsWith(base)).toBe(true)
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer api-secret"
      )
      const call = {
        method: init?.method ?? "GET",
        path: url.slice(base.length),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      const reply = respond(call.method, call.path, call.body)
      const status = reply.status ?? 200
      return Response.json(
        {
          result: reply.result ?? null,
          success: status < 400,
          errors: reply.errors ?? [],
          messages: [],
          result_info: reply.result_info,
        },
        { status }
      )
    },
  })
  return { rest, calls }
}

const repo = {
  name: "terminus",
  description: null,
  default_branch: "main",
  remote: "https://acct.artifacts.cloudflare.net/git/tn-1/terminus.git",
}

describe("Artifacts REST client", () => {
  it("deletes all namespace repositories across pages, including unrecorded candidates", async () => {
    const { rest, calls } = client((method, path) => {
      if (method === "DELETE") return { status: 202, result: { id: path } }
      if (path.includes("cursor="))
        return {
          result: [{ name: "unrecorded-candidate" }],
          result_info: { has_more: false },
        }
      return {
        result: [{ name: "terminus" }, { name: "station-a" }],
        result_info: { cursor: "next/page", has_more: true },
      }
    })
    await rest.deleteRepositories("tn-1")
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /tn-1/repos?limit=200",
      "GET /tn-1/repos?limit=200&cursor=next%2Fpage",
      "DELETE /tn-1/repos/terminus",
      "DELETE /tn-1/repos/station-a",
      "DELETE /tn-1/repos/unrecorded-candidate",
    ])
  })

  it("allows repository cleanup retries after some repositories are already deleted", async () => {
    const { rest } = client((method) =>
      method === "GET"
        ? { result: [{ name: "station-a" }] }
        : { status: 404, errors: [{ code: 10200, message: "Already deleted" }] }
    )
    await expect(rest.deleteRepositories("tn-1")).resolves.toBeUndefined()
    const failed = client(() => ({
      status: 403,
      errors: [{ code: 10400, message: "Not authorized" }],
    }))
    await expect(failed.rest.deleteRepositories("tn-1")).rejects.toThrow(
      "Not authorized"
    )
  })
  it("addresses repos, forks and tokens inside the requested namespace", async () => {
    const { rest, calls } = client((method, path) => {
      if (method === "GET") return { result: repo }
      if (path.endsWith("/fork")) return { result: { token: "art_v1_x" } }
      return { result: { id: "tok-1", plaintext: "art_v1_y" } }
    })
    using handle = await rest.namespace("tn-1").get("terminus")
    expect(await handle.info()).toEqual({
      name: "terminus",
      description: null,
      defaultBranch: "main",
      remote: repo.remote,
    })
    await handle.fork("train-1", {
      description: "Terminus fork: tn-1/terminus@abc",
      defaultBranchOnly: true,
    })
    expect(await handle.createToken("read", 3600)).toEqual({
      id: "tok-1",
      plaintext: "art_v1_y",
    })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /tn-1/repos/terminus",
      "GET /tn-1/repos/terminus",
      "POST /tn-1/repos/terminus/fork",
      "POST /tn-1/tokens",
    ])
    expect(calls[2]!.body).toEqual({
      name: "train-1",
      description: "Terminus fork: tn-1/terminus@abc",
      default_branch_only: true,
    })
    expect(calls[3]!.body).toEqual({
      repo: "terminus",
      scope: "read",
      ttl: 3600,
    })
  })

  it("maps numeric envelope errors to the symbolic codes the host checks", async () => {
    const { rest } = client(() => ({
      status: 404,
      errors: [{ code: 10200, message: "Repository not found" }],
    }))
    const failure = await rest
      .namespace("tn-1")
      .get("missing")
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ArtifactsApiError)
    expect(failure).toMatchObject({ code: "NOT_FOUND", status: 404 })

    const importing = client(() => ({
      status: 409,
      errors: [{ code: 10302, message: "Import in progress" }],
    }))
    await expect(
      importing.rest.namespace("tn-1").get("terminus")
    ).rejects.toMatchObject({ code: "IMPORT_IN_PROGRESS" })
  })

  it("treats an existing namespace as already ensured, but surfaces other failures", async () => {
    const exists = client(() => ({
      status: 409,
      errors: [{ code: 10201, message: "Namespace exists" }],
    }))
    await exists.rest.ensure("tn-1")
    expect(exists.calls[0]).toMatchObject({
      method: "POST",
      path: "",
      body: { namespace: "tn-1" },
    })

    const denied = client(() => ({
      status: 403,
      errors: [{ code: 10000, message: "Authentication error" }],
    }))
    await expect(denied.rest.ensure("tn-1")).rejects.toMatchObject({
      status: 403,
    })
  })

  it("revokes an initial plaintext token by matching its expiry to an active token id", async () => {
    const expires = 1760000000
    const { rest, calls } = client((method, path) => {
      if (path.includes("/tokens?"))
        return {
          result: [
            { id: "other", expires_at: "2026-10-05T00:00:00.000Z" },
            {
              id: "initial",
              expires_at: new Date(expires * 1000).toISOString(),
            },
          ],
        }
      if (method === "DELETE") return { result: { id: "initial" } }
      return { result: repo }
    })
    using handle = await rest.namespace("tn-1").get("terminus")
    expect(await handle.revokeToken(`art_v1_secret?expires=${expires}`)).toBe(
      true
    )
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/tn-1/tokens/initial",
    })
    expect(await handle.revokeToken("art_v1_secret?expires=1")).toBe(false)
  })

  it("imports a public URL into the namespace under the target name", async () => {
    const { rest, calls } = client(() => ({ result: { token: "art_v1_z" } }))
    expect(
      await rest.namespace("tn-1").import({
        source: { url: "https://github.com/owner/app.git" },
        target: { name: "terminus" },
      })
    ).toEqual({ token: "art_v1_z" })
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/tn-1/repos/terminus/import",
      body: { url: "https://github.com/owner/app.git" },
    })
  })

  it("requires an account and API token", () => {
    expect(
      () => new ArtifactsRestClient({ accountId: "", apiToken: "x" })
    ).toThrow("ARTIFACTS_ACCOUNT_ID")
  })
})
