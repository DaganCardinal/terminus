import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { ExecutionSandbox } from "./execution-sandbox"

function fakeContainer() {
  const fetch = vi
    .fn<(request: Request | string, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(
      async (request) =>
        new Response(typeof request === "string" ? "ready" : "demo app")
    )
  const container = {
    running: true,
    setInactivityTimeout: vi.fn(async () => {}),
    interceptAllOutboundHttp: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    getTcpPort: vi.fn(() => ({ fetch })),
    destroy: vi.fn(async () => {}),
  }
  return { container, fetch }
}

const saved = {
  token: "b".repeat(24),
  commit: "a".repeat(40),
  remote: "https://account.artifacts.cloudflare.net/git/default/train.git",
}

async function withSandbox(
  run: (
    sandbox: ExecutionSandbox,
    f: ReturnType<typeof fakeContainer>
  ) => Promise<void>
) {
  const stub = env.SANDBOX.getByName(`preview-test-${crypto.randomUUID()}`)
  await runInDurableObject(stub, async (instance, state) => {
    // The test environment adds TEST_MIGRATIONS to Env; the bound production
    // class uses the generated Env without that test-only field.
    const sandbox = instance as unknown as ExecutionSandbox
    await state.storage.put("trainPreview", saved)
    const f = fakeContainer()
    // Keep native Durable Object storage/context; replace only its container transport.
    const mock = vi
      .spyOn(sandbox as unknown as { container(): Container }, "container")
      .mockReturnValue(f.container as unknown as Container)
    try {
      await run(sandbox, f)
    } finally {
      mock.mockRestore()
    }
  })
}

describe("Sandbox preview routing", () => {
  it("installs an idle timeout before outbound setup and destroys a failed setup", async () => {
    await withSandbox(async (sandbox, f) => {
      f.container.interceptAllOutboundHttp.mockRejectedValueOnce(
        new Error("Outbound setup failed")
      )
      await expect(
        sandbox.configure({ repositories: [], allowModel: false })
      ).rejects.toThrow("Outbound setup failed")
      expect(f.container.setInactivityTimeout).toHaveBeenCalledWith(30 * 60_000)
      expect(
        f.container.setInactivityTimeout.mock.invocationCallOrder[0]
      ).toBeLessThan(
        f.container.interceptAllOutboundHttp.mock.invocationCallOrder[0]!
      )
      expect(f.container.destroy).toHaveBeenCalledTimes(1)
    })
  })
  it("reuses a running exact snapshot without reconfiguring its credentials", async () => {
    await withSandbox(async (sandbox, f) => {
      const result = await sandbox.prepareTrainPreview({
        ...saved,
        token: "new-read-secret",
        hostname: "localhost",
      })
      expect(result).toEqual({ token: saved.token })
      expect(f.container.destroy).not.toHaveBeenCalled()
      expect(f.fetch).toHaveBeenCalledWith(
        "http://localhost:8080/",
        expect.anything()
      )
    })
  })

  it("rejects incorrect tokens before opening a container port", async () => {
    await withSandbox(async (sandbox, f) => {
      const response = await sandbox.fetchTrainPreview(
        new Request("https://preview.test/"),
        "c".repeat(24)
      )
      expect(response.status).toBe(404)
      expect(f.container.getTcpPort).not.toHaveBeenCalled()
    })
  })

  it("stops a running preview so open tabs report it stopped", async () => {
    await withSandbox(async (sandbox, f) => {
      f.container.destroy.mockImplementation(async () => {
        f.container.running = false
      })
      await sandbox.stopTrainPreview()
      await sandbox.stopTrainPreview()
      expect(f.container.destroy).toHaveBeenCalledTimes(1)
      const response = await sandbox.fetchTrainPreview(
        new Request("https://preview.test/"),
        saved.token
      )
      expect(response.status).toBe(410)
    })
  })

  it("returns an expired response without restarting the Sandbox", async () => {
    await withSandbox(async (sandbox, f) => {
      f.container.running = false
      const response = await sandbox.fetchTrainPreview(
        new Request("https://preview.test/"),
        saved.token
      )
      expect(response.status).toBe(410)
      expect(f.container.getTcpPort).not.toHaveBeenCalled()
    })
  })

  it("forwards the full path to only port 8080 and strips credentials", async () => {
    await withSandbox(async (sandbox, f) => {
      const request = new Request(
        "https://preview.test/assets/main.js?version=1",
        {
          headers: {
            cookie: "session=private",
            authorization: "Bearer secret",
            "cf-access-jwt-assertion": "signed-identity",
            "cf-access-authenticated-user-email": "private@example.test",
            "cf-access-client-id": "service-id",
            "cf-access-client-secret": "service-secret",
          },
        }
      )
      const response = await sandbox.fetchTrainPreview(request, saved.token)
      expect(f.container.getTcpPort).toHaveBeenCalledWith(8080)
      const forwarded = f.fetch.mock.calls[0]![0] as Request
      expect(forwarded.url).toBe("http://preview.test/assets/main.js?version=1")
      expect(forwarded.headers.has("cookie")).toBe(false)
      expect(forwarded.headers.has("authorization")).toBe(false)
      expect(
        [...forwarded.headers.keys()].some((name) =>
          name.startsWith("cf-access-")
        )
      ).toBe(false)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    })
  })
})
