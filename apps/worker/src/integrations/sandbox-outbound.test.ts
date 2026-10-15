import { env as testEnv } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { planToolServer } from "@terminus/agent-runtime"
import { seedDispatchPlan } from "../../test/fixtures"
import { DispatchDraftStore } from "./dispatch-draft-store"
import { outboundRequest } from "./sandbox-outbound"

const env = {
  AI_GATEWAY_ACCOUNT_ID: "account",
  AI_GATEWAY_ID: "gateway",
  AI_GATEWAY_TOKEN: "worker-secret",
  DB: testEnv.DB,
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
      const send = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
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
      // Claude Code always calls the beta Messages route.
      const beta = await outboundRequest(
        request(url + "?beta=true"),
        env,
        grant,
        send
      )
      expect(beta.status).toBe(provider === "anthropic" ? 200 : 403)
      for (const target of [
        url + "?alias=other",
        url + "?beta=true&alias=other",
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
      expect(send).toHaveBeenCalledTimes(provider === "anthropic" ? 2 : 1)
    }
  )

  it("checks tools that Codex declares in namespaces and additional_tools input items", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const grant = {
      repositories: [],
      allowModel: true,
      provider: "openai" as const,
      model: "openai/gpt-6-luna",
    }
    const status = async (tools: unknown[], top = false) =>
      (
        await outboundRequest(
          new Request(
            "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses",
            {
              method: "POST",
              body: JSON.stringify({
                model: "gpt-6-luna",
                ...(top ? { tools } : {}),
                input: [
                  ...(top
                    ? []
                    : [{ type: "additional_tools", role: "developer", tools }]),
                  { type: "message", role: "user", content: [] },
                ],
              }),
            }
          ),
          env,
          grant,
          send
        )
      ).status
    // The shape Codex 0.156.1 sends for GPT-6 models.
    const codex = [
      {
        type: "namespace",
        name: "functions",
        tools: [
          { type: "custom", name: "exec" },
          { type: "function", name: "wait" },
        ],
      },
      {
        type: "namespace",
        name: "collaboration",
        tools: [{ type: "function", name: "spawn_agent" }],
      },
    ]
    expect(await status(codex)).toBe(200)
    expect(await status(codex, true)).toBe(200)
    for (const tools of [
      [{ type: "web_search" }],
      [...codex, { type: "image_generation" }],
      [{ type: "namespace", name: "n", tools: [{ type: "web_search" }] }],
      [
        {
          type: "namespace",
          name: "outer",
          tools: [
            { type: "namespace", name: "inner", tools: [{ type: "mcp" }] },
          ],
        },
      ],
      [{ type: "namespace", name: "untyped" }],
      [null],
    ]) {
      expect(await status(tools)).toBe(403)
      expect(await status(tools, true)).toBe(403)
    }
    expect(send).toHaveBeenCalledTimes(2)
  })

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
        requestId: info.mock.calls.find(
          ([line]) => line === "Station model request started"
        )![1].requestId,
        reference: "abc123",
      })
    )
    const logs = JSON.stringify([info.mock.calls, failed.mock.calls])
    for (const secret of ["worker-secret", "station-token", "private-prompt"])
      expect(logs).not.toContain(secret)
  })
  describe("hedging stalled Workers AI calls", () => {
    const workersAi =
      "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions"
    const streamedRequest = (stream = true) =>
      new Request(workersAi, {
        method: "POST",
        body: JSON.stringify({ model, stream, messages: [] }),
      })
    const affine = { ...network, sessionAffinity: "ses_sandbox" }
    /** A response that never arrives unless the request is aborted. */
    const stalled = (forwarded: Request) =>
      new Promise<Response>((_, reject) =>
        forwarded.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      )
    const after = (ms: number, response: () => Response) =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(response()), ms)
      )
    const sent = (send: ReturnType<typeof vi.fn<typeof fetch>>) =>
      send.mock.calls.map(([forwarded]) => forwarded as Request)

    it("aborts both original and hedged requests when their caller stops", async () => {
      const abort = new AbortController()
      let copiesStarted!: () => void
      const ready = new Promise<void>((resolve) => {
        copiesStarted = resolve
      })
      const send = vi.fn<typeof fetch>(async (request) => {
        if (send.mock.calls.length === 2) copiesStarted()
        return stalled(request as Request)
      })
      const result = outboundRequest(
        new Request(streamedRequest(), { signal: abort.signal }),
        env,
        affine,
        send,
        5
      )
      const rejected = expect(result).rejects.toMatchObject({
        name: "AbortError",
      })
      await ready
      abort.abort()
      await rejected
      expect(sent(send)).toHaveLength(2)
      expect(sent(send).every((request) => request.signal.aborted)).toBe(true)
    })

    it("preserves cancellation after headers arrive, including non-streamed calls", async () => {
      for (const stream of [true, false]) {
        const abort = new AbortController()
        const send = vi.fn<typeof fetch>(async () => new Response("answer"))
        const response = await outboundRequest(
          new Request(streamedRequest(stream), { signal: abort.signal }),
          env,
          affine,
          send,
          5
        )
        abort.abort()
        expect(sent(send)[0]!.signal.aborted).toBe(true)
        await response.body?.cancel()
      }
    })

    it("sends a copy without session affinity when headers are late, and aborts the original", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {})
      let calls = 0
      const send = vi.fn<typeof fetch>(async (input) =>
        calls++ === 0
          ? stalled(input as Request)
          : new Response("from the copy")
      )
      const response = await outboundRequest(
        streamedRequest(),
        env,
        affine,
        send,
        20
      )
      expect(await response.text()).toBe("from the copy")
      const [original, copy] = sent(send)
      expect(original!.signal.aborted).toBe(true)
      expect(original!.headers.get("x-session-affinity")).toBe("ses_sandbox")
      expect(copy!.headers.has("x-session-affinity")).toBe(false)
      expect(copy!.headers.get("authorization")).toBe("Bearer worker-secret")
      expect(await copy!.json()).toMatchObject({ model, stream: true })
    })
    it("keeps the original when it answers first, even after the copy is sent", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {})
      let calls = 0
      const send = vi.fn<typeof fetch>(async (input) =>
        calls++ === 0
          ? after(40, () => new Response("from the original"))
          : stalled(input as Request)
      )
      const response = await outboundRequest(
        streamedRequest(),
        env,
        affine,
        send,
        20
      )
      expect(await response.text()).toBe("from the original")
      expect(sent(send)[1]!.signal.aborted).toBe(true)
    })
    it("never copies prompt answers, unstreamed calls, other providers, or early errors", async () => {
      const prompt = vi.fn<typeof fetch>(async () => new Response("ok"))
      await outboundRequest(streamedRequest(), env, affine, prompt, 20)
      const unstreamed = vi.fn<typeof fetch>(async () =>
        after(40, () => new Response("ok"))
      )
      await outboundRequest(streamedRequest(false), env, affine, unstreamed, 20)
      const anthropic = vi.fn<typeof fetch>(async () =>
        after(40, () => new Response("ok"))
      )
      await outboundRequest(
        new Request(
          "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
          {
            method: "POST",
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              stream: true,
            }),
          }
        ),
        env,
        {
          repositories: [],
          allowModel: true,
          provider: "anthropic",
          model: "anthropic/claude-haiku-4-5-20251001",
        },
        anthropic,
        20
      )
      const overloaded = vi.fn<typeof fetch>(
        async () => new Response("busy", { status: 429 })
      )
      const rejected = await outboundRequest(
        streamedRequest(),
        env,
        affine,
        overloaded,
        20
      )
      expect(rejected.status).toBe(429)
      await new Promise((resolve) => setTimeout(resolve, 40))
      for (const send of [prompt, unstreamed, anthropic, overloaded])
        expect(send).toHaveBeenCalledTimes(1)
    })
    it("waits for the other request before returning an error, and reports the first error when both fail", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {})
      let calls = 0
      const recovered = vi.fn<typeof fetch>(async () =>
        calls++ === 0
          ? after(40, () => new Response("from the original"))
          : new Response("busy", { status: 503 })
      )
      const response = await outboundRequest(
        streamedRequest(),
        env,
        affine,
        recovered,
        20
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("from the original")

      calls = 0
      const failing = vi.fn<typeof fetch>(async () => {
        if (calls++ === 0) {
          await after(40, () => new Response())
          throw new Error("original failed")
        }
        throw new Error("copy failed")
      })
      vi.spyOn(console, "error").mockImplementation(() => {})
      await expect(
        outboundRequest(streamedRequest(), env, affine, failing, 20)
      ).rejects.toThrow("copy failed")
    })
    it("records which request answered and when the copy was sent", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {})
      let calls = 0
      const send = vi.fn<typeof fetch>(async (input) =>
        calls++ === 0 ? stalled(input as Request) : new Response("data: {}\n\n")
      )
      await (
        await outboundRequest(streamedRequest(), env, affine, send, 20)
      ).text()
      expect(info).toHaveBeenCalledWith(
        "Station model response received",
        expect.objectContaining({
          winner: "copy",
          hedgedAtMs: expect.any(Number),
        })
      )
    })
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
    expect(forwarded.headers.has("x-session-affinity")).toBe(false)
  })
  it("sets the role model's frozen Workers AI reasoning level, keeping housekeeping low", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const call = (model: string, reasoning_effort?: string) =>
      new Request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify({ model, reasoning_effort }),
        }
      )
    const glm = {
      ...network,
      model: "@cf/zai-org/glm-5.3",
      reasoning: "high" as const,
    }
    // The harness cannot raise its own level.
    await outboundRequest(call("@cf/zai-org/glm-5.3", "max"), env, glm, send)
    await outboundRequest(call(model), env, glm, send)
    await outboundRequest(
      call(model),
      env,
      { ...network, reasoning: "max" },
      send
    )
    const sent = await Promise.all(
      send.mock.calls.map(([forwarded]) =>
        (forwarded as Request).json<{ reasoning_effort: string }>()
      )
    )
    expect(sent.map((body) => body.reasoning_effort)).toEqual([
      "high",
      "low",
      "max",
    ])
  })
  it("pins Workers AI requests to the Sandbox's own session affinity, ignoring the caller's", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const request = (url: string, model: string) =>
      new Request(url, {
        method: "POST",
        headers: { "x-session-affinity": "ses_chosen-by-harness" },
        body: JSON.stringify({ model }),
      })
    const sessionAffinity = "ses_sandbox"
    await outboundRequest(
      request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        model
      ),
      env,
      { ...network, sessionAffinity },
      send
    )
    await outboundRequest(
      request(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
        "claude-haiku-4-5-20251001"
      ),
      env,
      {
        repositories: [],
        allowModel: true,
        provider: "anthropic",
        model: "anthropic/claude-haiku-4-5-20251001",
        sessionAffinity,
      },
      send
    )
    const [workersAi, anthropic] = send.mock.calls.map(
      ([forwarded]) => forwarded as Request
    )
    expect(workersAi!.headers.get("x-session-affinity")).toBe(sessionAffinity)
    expect(anthropic!.headers.has("x-session-affinity")).toBe(false)
  })
  it("also allows the role model's utility model, from the same provider only", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const call = (model: string) =>
      new Request(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
        { method: "POST", body: JSON.stringify({ model }) }
      )
    const sonnet = {
      repositories: [],
      allowModel: true,
      provider: "anthropic" as const,
      model: "anthropic/claude-sonnet-5-5",
    }
    for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"])
      expect(
        (await outboundRequest(call(model), env, sonnet, send)).status
      ).toBe(200)
    for (const model of ["claude-haiku-4-5-20251001", "gpt-6-luna"])
      expect(
        (await outboundRequest(call(model), env, sonnet, send)).status
      ).toBe(403)
    const kimi = {
      ...network,
      model: "@cf/moonshotai/kimi-k2.7-code",
    }
    const workersAi = (model: string) =>
      new Request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model }) }
      )
    expect(
      (
        await outboundRequest(
          workersAi("@cf/zai-org/glm-5.3-flash"),
          env,
          kimi,
          send
        )
      ).status
    ).toBe(200)
    expect(
      (await outboundRequest(workersAi("@cf/zai-org/glm-5.3"), env, kimi, send))
        .status
    ).toBe(403)
    expect(send).toHaveBeenCalledTimes(3)
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

  it("serves the Dispatcher's plan tools as an MCP server, saving the draft in D1", async () => {
    const plan = await seedDispatchPlan()
    const send = vi.fn<typeof fetch>()
    const planning = {
      repositories: [],
      allowModel: true,
      model,
      proposalCheck: {
        planId: plan.id,
        network: {
          projectChecks: [{ name: "test", command: ["npm", "test"] }],
          activeLines: [],
        },
        baseline: null,
      },
    }
    const rpc = async (body: object, method = "POST") => {
      const response = await outboundRequest(
        new Request(planToolServer.url, {
          method,
          ...(method === "POST"
            ? {
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                },
                body: JSON.stringify(body),
              }
            : {}),
        }),
        env,
        planning,
        send
      )
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : null,
      }
    }

    // The handshake OpenCode 1.18.32 performs.
    expect(
      await rpc({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      })
    ).toMatchObject({
      status: 200,
      body: {
        id: 0,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
        },
      },
    })
    expect(
      await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })
    ).toEqual({ status: 202, body: null })
    expect((await rpc({}, "GET")).status).toBe(405)
    const tools = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .body as {
      result: {
        tools: {
          name: string
          inputSchema: {
            properties: Record<
              string,
              { type?: string; anyOf?: { type?: string }[] }
            >
          }
        }[]
      }
    }
    expect(tools.result.tools.map((t) => t.name)).toEqual([
      "set_plan_outline",
      "put_station",
      "inspect_plan",
      "finalize_plan",
    ])
    // GLM passes the outline as JSON text, so a nesting slip still arrives.
    expect(tools.result.tools[0]!.inputSchema.properties.outline!.type).toBe(
      "string"
    )
    expect(
      tools.result.tools[1]!.inputSchema.properties.scope!.anyOf?.map(
        (s) => s.type
      )
    ).toEqual(["array", "string"])

    type Reply = { result: { content: { text: string }[]; isError?: boolean } }
    const call = async (name: string, args: unknown) =>
      (
        await rpc({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: args },
        })
      ).body as Reply
    const station = (key: string) => ({
      key,
      name: `Station ${key}`,
      goal: `Deliver ${key}`,
      changeKind: "implementation",
      changeDescription: `Implement ${key}`,
      scope: `Only ${key}`,
      expectedAreas: `src/${key}.ts`,
      invariants: "Existing behavior stays intact",
      acceptanceCriteria: `${key} works`,
      expectedEvidence: "test",
    })
    const outline = {
      summary: "One Line.",
      lines: [
        {
          key: "footer",
          name: "Footer",
          unloadRecommendation: { mode: "auto", reason: "Small." },
          stations: ["a", "b", "c"],
        },
      ],
    }
    const text = (reply: Reply) => reply.result.content[0]!.text
    expect(
      text(await call("set_plan_outline", { outline: JSON.stringify(outline) }))
    ).toMatch(/^Saved the outline/)
    // Calls in one message arrive together; each saves only its own piece.
    const saved = await Promise.all(
      ["a", "b", "c"].map((key) =>
        call("put_station", {
          ...station(key),
          ...(key === "b"
            ? { scope: ["Only b"], expectedAreas: ["src/b.ts"] }
            : {}),
        })
      )
    )
    for (const reply of saved) expect(text(reply)).toMatch(/^Saved Station/)
    const rejected = await call("put_station", { key: "a" })
    expect(text(rejected)).toMatch(/^Not saved:/)
    expect(rejected.result.isError).toBeUndefined()
    expect(text(await call("finalize_plan", {}))).toMatch(/^Accepted:/)

    const draft = await new DispatchDraftStore(testEnv.DB).read(plan.id)
    expect(draft.outline).toEqual(outline)
    expect(Object.keys(draft.stations)).toEqual(["a", "b", "c"])
    // The rejected call changed nothing.
    expect(draft.stations.a!.goal).toBe("Deliver a")
    expect(draft.stations.a!.scope).toEqual(["Only a"])
    expect(draft.stations.b!.scope).toEqual(["Only b"])

    expect(
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "submit_proposal", arguments: {} },
      })
    ).toMatchObject({ body: { id: 3, error: { code: -32602 } } })
    expect(send).not.toHaveBeenCalled()

    // Without a granted plan, the same address is just another refused destination.
    const refused = await outboundRequest(
      new Request(planToolServer.url, { method: "POST", body: "{}" }),
      env,
      network,
      send
    )
    expect(refused.status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it("reports a failed save as a tool error the agent can retry", async () => {
    const plan = await seedDispatchPlan()
    await testEnv.DB.prepare(
      "UPDATE networks SET deleting = 1 WHERE id = (SELECT network_id FROM dispatch_plans WHERE id = ?)"
    )
      .bind(plan.id)
      .run()
    const response = await outboundRequest(
      new Request(planToolServer.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "set_plan_outline",
            arguments: {
              outline: {
                summary: "One Line.",
                lines: [
                  {
                    key: "footer",
                    name: "Footer",
                    unloadRecommendation: { mode: "auto", reason: "Small." },
                    stations: ["a"],
                  },
                ],
              },
            },
          },
        }),
      }),
      env,
      {
        repositories: [],
        allowModel: true,
        model,
        proposalCheck: {
          planId: plan.id,
          network: {
            projectChecks: [{ name: "test", command: ["npm", "test"] }],
            activeLines: [],
          },
          baseline: null,
        },
      }
    )
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("Try the same call again") }],
      },
    })
  })
})
