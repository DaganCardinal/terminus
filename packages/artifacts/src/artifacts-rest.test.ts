import { describe, expect, it } from "vitest"
import { errorKind } from "@terminus/protocol"
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
    // info() answers from the lookup get() already made.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /tn-1/repos/terminus",
      "POST /tn-1/repos/terminus/fork",
      "POST /tn-1/tokens",
    ])
    expect(calls[1]!.body).toEqual({
      name: "train-1",
      description: "Terminus fork: tn-1/terminus@abc",
      default_branch_only: true,
    })
    expect(calls[2]!.body).toEqual({
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

  it("keeps an unlisted numeric code and the request shape for diagnosis, never names", async () => {
    const { rest } = client((method) =>
      method === "GET"
        ? { result: repo }
        : { status: 500, errors: [{ code: 10499, message: "Not ready" }] }
    )
    using handle = await rest.namespace("tn-1").get("train-1")
    const failure = await handle
      .fork("station-1", { description: "", defaultBranchOnly: true })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      apiCode: 10499,
      operation: "POST /repos/:/fork",
    })
    expect(errorKind(failure)).toBe(
      'ArtifactsApiError(INTERNAL_ERROR, status 500, api 10499, POST /repos/:/fork, "Not ready")'
    )
  })

  it("logs an unlisted code's message without anything token-like, and no message for listed codes", async () => {
    const denied = client(() => ({
      status: 403,
      errors: [
        {
          code: 10004,
          message: 'Denied for "art_v1_0123456789abcdefghijklmnop" <x>',
        },
      ],
    }))
    const failure = await denied.rest
      .namespace("tn-1")
      .get("station-1")
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ apiMessage: "Denied for … x" })
    expect(errorKind(failure)).toBe(
      'ArtifactsApiError(INTERNAL_ERROR, status 403, api 10004, GET /repos/:, "Denied for … x")'
    )

    const missing = client(() => ({
      status: 404,
      errors: [{ code: 10200, message: "Repository station-1 not found" }],
    }))
    expect(
      await missing.rest
        .namespace("tn-1")
        .get("station-1")
        .catch((error: unknown) => error)
    ).toMatchObject({ code: "NOT_FOUND", apiMessage: null })
  })

  it("deletes one repository, and treats an already deleted one as done", async () => {
    let deleted = false
    const { rest, calls } = client((method) => {
      if (method === "GET") return { result: repo }
      if (deleted)
        return { status: 404, errors: [{ code: 10200, message: "Gone" }] }
      deleted = true
      return { status: 202, result: { id: "station-1" } }
    })
    using handle = await rest.namespace("tn-1").get("station-1")
    await handle.delete()
    await handle.delete()
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /tn-1/repos/station-1",
      "DELETE /tn-1/repos/station-1",
      "DELETE /tn-1/repos/station-1",
    ])
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

  it("revokes a token by id without looking up its repository, and treats a missing one as done", async () => {
    let revoked = false
    const { rest, calls } = client(() => {
      if (revoked)
        return { status: 404, errors: [{ code: 10200, message: "Gone" }] }
      revoked = true
      return { result: { id: "tok-1" } }
    })
    expect(await rest.namespace("tn-1").revokeToken("tok-1")).toBe(true)
    expect(await rest.namespace("tn-1").revokeToken("tok-1")).toBe(false)
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "DELETE /tn-1/tokens/tok-1",
      "DELETE /tn-1/tokens/tok-1",
    ])
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
    ).toThrow("CLOUDFLARE_ACCOUNT_ID")
  })
})

describe("Artifacts REST object reads", () => {
  const commit = "1".repeat(40)
  const tree = "2".repeat(40)
  const blob = "3".repeat(40)
  const envelope = (result: unknown) =>
    Response.json({ result, success: true, errors: [], messages: [] })
  const notFound = () =>
    Response.json(
      {
        result: null,
        success: false,
        errors: [{ code: 10200, message: "Not found" }],
        messages: [],
      },
      { status: 404 }
    )
  // Response shapes follow live probes of the Artifacts API (2026-10-11).
  function objects(respond: (method: string, path: string) => Response) {
    const calls: string[] = []
    const rest = new ArtifactsRestClient({
      accountId: "acct",
      apiToken: "api-secret",
      fetch: async (input, init) => {
        const method = init?.method ?? "GET"
        const path = String(input).slice(base.length)
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer api-secret"
        )
        calls.push(`${method} ${path}`)
        return respond(method, path)
      },
    })
    return { read: rest.namespace("tn-1").objects!("terminus"), calls }
  }

  it("reads commits, trees, and blobs by hash", async () => {
    const entry = { name: "src", mode: "40000", hash: tree, type: "tree" }
    const { read, calls } = objects((method, path) => {
      if (path.endsWith(`/commit/${commit}`))
        return envelope({ hash: commit, treeHash: tree, parents: [] })
      if (path.endsWith(`/tree/${tree}`)) return envelope([entry])
      if (method === "HEAD")
        return new Response(null, { headers: { "content-length": "5" } })
      return new Response("hello", {
        headers: { "content-type": "application/octet-stream" },
      })
    })
    expect(await read.treeOf(commit)).toBe(tree)
    expect(await read.tree(tree)).toEqual([entry])
    expect(await read.blobSize(blob)).toBe(5)
    expect(await new Response(await read.blob(blob)).text()).toBe("hello")
    expect(calls).toEqual([
      `GET /tn-1/repos/terminus/commit/${commit}`,
      `GET /tn-1/repos/terminus/tree/${tree}`,
      `HEAD /tn-1/repos/terminus/blob/${blob}`,
      `GET /tn-1/repos/terminus/blob/${blob}`,
    ])
  })

  it("maps missing objects to NOT_FOUND, including a HEAD without a body", async () => {
    const { read } = objects((method) =>
      method === "HEAD" ? new Response(null, { status: 404 }) : notFound()
    )
    await expect(read.treeOf(commit)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(read.blob(blob)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(read.blobSize(blob)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    })
  })

  it("never puts anything but a full hash in an object path", async () => {
    const { read, calls } = objects(() => envelope(null))
    await expect(read.treeOf("main")).rejects.toThrow("full Git commit")
    await expect(read.tree("../tokens")).rejects.toThrow("full Git object")
    await expect(read.blob(`${blob}/x`)).rejects.toThrow("full Git object")
    expect(calls).toEqual([])
  })

  it("refuses a blob size Artifacts does not report", async () => {
    const { read } = objects(() => new Response(null))
    await expect(read.blobSize(blob)).rejects.toThrow("blob size")
  })
})
