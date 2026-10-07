import { afterEach, describe, expect, it, vi } from "vitest"
import { outboundRequest } from "./sandbox-outbound"

const env = {
  AI_GATEWAY_ACCOUNT_ID: "account",
  AI_GATEWAY_ID: "gateway",
  AI_GATEWAY_TOKEN: "worker-secret",
}
const model = "@cf/zai-org/glm-5.3-flash"
const remote =
  "https://account.artifacts.cloudflare.net/git/default/station.git"
const network = {
  repositories: [{ remote, token: "station-token", scope: "write" as const }],
  allowModel: true,
  model,
}

afterEach(() => vi.restoreAllMocks())

describe("Sandbox outbound capabilities", () => {
  it.each([
    {
      provider: "anthropic" as const,
      model: "anthropic/claude-haiku-4-5-20251001",
      apiModel: "claude-haiku-4-5-20251001",
      endpoint: "v1/messages",
    },
    {
      provider: "openai" as const,
      model: "openai/gpt-6-luna",
      apiModel: "gpt-6-luna",
      endpoint: "responses",
    },
  ])(
    "authorizes exact $provider requests, replaces auth and preserves streams",
    async ({ provider, model, apiModel, endpoint }) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"))
          controller.close()
        },
      })
      const send = vi.fn<typeof fetch>(
        async () =>
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          })
      )
      const url = `https://gateway.ai.cloudflare.com/v1/account/gateway/${provider}/${endpoint}`
      const request = (
        target = url,
        body: object = { model: apiModel, stream: true }
      ) =>
        new Request(target, {
          method: "POST",
          headers: {
            authorization: "untrusted",
            "x-api-key": "untrusted",
            "cf-aig-authorization": "untrusted",
            "cf-aig-byo-key": "alternate-billing",
            "cf-aig-gateway-id": "other",
            cookie: "untrusted",
          },
          body: JSON.stringify(body),
        })
      const grant = { repositories: [], allowModel: true, provider, model }
      const response = await outboundRequest(request(), env, grant, send)
      expect(response.body).toBe(stream)
      expect(await response.text()).toBe("data: first\n\n")
      const forwarded = send.mock.calls[0]![0] as Request
      expect(forwarded.headers.get("cf-aig-authorization")).toBe(
        "Bearer worker-secret"
      )
      for (const header of [
        "authorization",
        "x-api-key",
        "cookie",
        "cf-aig-byo-key",
        "cf-aig-gateway-id",
      ])
        expect(forwarded.headers.has(header)).toBe(false)
      expect(forwarded.redirect).toBe("manual")
      expect(await forwarded.json()).toEqual({ model: apiModel, stream: true })
      for (const target of [
        url + "?alias=other",
        url.replace("/gateway/", "/other/"),
        url.replace(endpoint, "models"),
        "https://api.openai.com/v1/responses",
      ])
        expect(
          (await outboundRequest(request(target), env, grant, send)).status
        ).toBe(403)
      expect(
        (
          await outboundRequest(
            request(url, { model: "different" }),
            env,
            grant,
            send
          )
        ).status
      ).toBe(403)
      expect(
        (
          await outboundRequest(
            request(url, { model: apiModel, tools: [{ type: "web_search" }] }),
            env,
            grant,
            send
          )
        ).status
      ).toBe(403)
      expect(send).toHaveBeenCalledTimes(1)
    }
  )

  it("does not follow redirects or retry upstream errors with another provider", async () => {
    const request = () =>
      new Request(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses",
        { method: "POST", body: JSON.stringify({ model: "gpt-6-luna" }) }
      )
    const grant = {
      repositories: [],
      allowModel: true,
      provider: "openai" as const,
      model: "openai/gpt-6-luna",
    }
    const redirect = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://example.com" },
        })
    )
    expect(
      (await outboundRequest(request(), env, grant, redirect)).status
    ).toBe(502)
    const failure = vi.fn<typeof fetch>(
      async () => new Response("quota exceeded", { status: 429 })
    )
    expect((await outboundRequest(request(), env, grant, failure)).status).toBe(
      429
    )
    expect(failure).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledTimes(1)
  })
  it("correlates model transport failures without leaking request contents or credentials", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failed = vi.spyOn(console, "error").mockImplementation(() => {})
    const error = new Error(
      "internal error; reference = abc123 worker-secret private-prompt"
    )
    const send = vi.fn<typeof fetch>(async () => {
      throw error
    })
    await expect(
      outboundRequest(
        new Request(
          "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
          {
            method: "POST",
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "private-prompt" }],
            }),
          }
        ),
        env,
        network,
        send
      )
    ).rejects.toBe(error)
    expect(failed).toHaveBeenCalledWith(
      "Station model request failed",
      expect.objectContaining({
        requestId: info.mock.calls[0]![1].requestId,
        reference: "abc123",
      })
    )
    const logs = JSON.stringify([info.mock.calls, failed.mock.calls])
    for (const secret of ["worker-secret", "station-token", "private-prompt"])
      expect(logs).not.toContain(secret)
  })
  it("injects the model credential only for the configured account, route, and model", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const request = new Request(
      "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer placeholder",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages: [] }),
      }
    )
    expect((await outboundRequest(request, env, network, send)).status).toBe(
      200
    )
    const forwarded = send.mock.calls[0]![0] as Request
    expect(forwarded.headers.get("authorization")).toBe("Bearer worker-secret")
    expect(forwarded.headers.get("cf-aig-gateway-id")).toBe("gateway")
    expect(forwarded.redirect).toBe("manual")
    expect(await forwarded.json()).toMatchObject({
      model,
      reasoning_effort: "low",
    })
  })
  it("blocks attempts to use a different model or access the model from a Git-only Sandbox", async () => {
    const send = vi.fn<typeof fetch>()
    const request = () =>
      new Request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model: "another-model" }) }
      )
    expect((await outboundRequest(request(), env, network, send)).status).toBe(
      403
    )
    expect(
      (
        await outboundRequest(
          request(),
          env,
          { ...network, allowModel: false },
          send
        )
      ).status
    ).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })
  it("grants Station Git access without allowing any Train or Terminus repository", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const discovery = new Request(`${remote}/info/refs?service=git-upload-pack`)
    expect((await outboundRequest(discovery, env, network, send)).status).toBe(
      200
    )
    expect(
      (send.mock.calls[0]![0] as Request).headers.get("authorization")
    ).toBe("Bearer station-token")
    for (const url of [
      remote.replace("station.git", "train.git") + "/git-receive-pack",
      remote.replace("station.git", "terminus.git") + "/git-receive-pack",
      "https://example.com/leak",
      remote.replace("https:", "http:") + "/git-receive-pack",
    ]) {
      expect(
        (
          await outboundRequest(
            new Request(url, { method: "POST" }),
            env,
            network,
            send
          )
        ).status
      ).toBe(403)
    }
    expect(send).toHaveBeenCalledTimes(1)
  })
  it("limits Technician access to its configured model, writable workspace and read-only Train", async () => {
    const technicianModel = "@cf/test/technician"
    const repairRemote = remote.replace("station.git", "repair.git")
    const trainRemote = remote.replace("station.git", "train.git")
    const repairNetwork = {
      repositories: [
        {
          remote: repairRemote,
          token: "repair-token",
          scope: "write" as const,
        },
        {
          remote: trainRemote,
          token: "train-read-token",
          scope: "read" as const,
        },
      ],
      allowModel: true,
      model: technicianModel,
    }
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const request = (id: string) =>
      new Request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model: id }) }
      )
    expect(
      (
        await outboundRequest(
          request(technicianModel),
          env,
          repairNetwork,
          send
        )
      ).status
    ).toBe(200)
    expect(
      (await outboundRequest(request(model), env, repairNetwork, send)).status
    ).toBe(403)
    expect(
      (
        await outboundRequest(
          new Request(`${repairRemote}/git-receive-pack`, { method: "POST" }),
          env,
          repairNetwork,
          send
        )
      ).status
    ).toBe(200)
    for (const url of [
      `${trainRemote}/git-receive-pack`,
      `${repairRemote.replace("repair.git", "terminus.git")}/git-receive-pack`,
    ])
      expect(
        (
          await outboundRequest(
            new Request(url, { method: "POST" }),
            env,
            repairNetwork,
            send
          )
        ).status
      ).toBe(403)
    expect(
      (
        await outboundRequest(
          new Request(`${trainRemote}/git-upload-pack`, { method: "POST" }),
          env,
          repairNetwork,
          send
        )
      ).status
    ).toBe(200)
  })
  it("refuses writes with a read-only grant and strips credentials from npm requests", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const readOnly = {
      repositories: [{ ...network.repositories[0]!, scope: "read" as const }],
      allowModel: false,
    }
    expect(
      (
        await outboundRequest(
          new Request(`${remote}/git-receive-pack`, { method: "POST" }),
          env,
          readOnly,
          send
        )
      ).status
    ).toBe(403)
    await outboundRequest(
      new Request("https://registry.npmjs.org/react", {
        headers: { authorization: "Bearer placeholder" },
      }),
      env,
      network,
      send
    )
    expect(
      (send.mock.calls[0]![0] as Request).headers.has("authorization")
    ).toBe(false)
  })
})
