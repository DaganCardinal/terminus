import { afterEach, describe, expect, it, vi } from "vitest"
import { outboundRequest } from "./sandbox-outbound"

const env = {
  AI_GATEWAY_ACCOUNT_ID: "account",
  AI_GATEWAY_ID: "gateway",
  AI_GATEWAY_TOKEN: "worker-secret",
  STATION_AGENT_MODEL: "@cf/zai-org/glm-5.3-flash",
}
const remote =
  "https://account.artifacts.cloudflare.net/git/default/station.git"
const network = {
  repositories: [{ remote, token: "station-token", scope: "write" as const }],
  allowModel: true,
}

afterEach(() => vi.restoreAllMocks())

describe("Sandbox outbound capabilities", () => {
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
              model: env.STATION_AGENT_MODEL,
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
        body: JSON.stringify({ model: env.STATION_AGENT_MODEL, messages: [] }),
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
      model: env.STATION_AGENT_MODEL,
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
    const roleEnv = { ...env, TECHNICIAN_MODEL: "@cf/test/technician" }
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
      modelRole: "technician" as const,
    }
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))
    const request = (model: string) =>
      new Request(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model }) }
      )
    expect(
      (
        await outboundRequest(
          request(roleEnv.TECHNICIAN_MODEL),
          roleEnv,
          repairNetwork,
          send
        )
      ).status
    ).toBe(200)
    expect(
      (
        await outboundRequest(
          request(env.STATION_AGENT_MODEL),
          roleEnv,
          repairNetwork,
          send
        )
      ).status
    ).toBe(403)
    expect(
      (
        await outboundRequest(
          new Request(`${repairRemote}/git-receive-pack`, { method: "POST" }),
          roleEnv,
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
            roleEnv,
            repairNetwork,
            send
          )
        ).status
      ).toBe(403)
    expect(
      (
        await outboundRequest(
          new Request(`${trainRemote}/git-upload-pack`, { method: "POST" }),
          roleEnv,
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
