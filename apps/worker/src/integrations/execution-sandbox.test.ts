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
  let exit = () => {}
  const container = {
    running: true,
    start: vi.fn(() => {
      container.running = true
    }),
    // Resolves when the container stops on its own.
    monitor: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          exit = () => {
            container.running = false
            resolve()
          }
        })
    ),
    exit: () => exit(),
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

// Previews run in the agentless WorkspaceSandbox, so tests default to it.
async function withSandbox(
  run: (
    sandbox: ExecutionSandbox,
    f: ReturnType<typeof fakeContainer>
  ) => Promise<void>,
  binding: "SANDBOX" | "WORKSPACE_SANDBOX" = "WORKSPACE_SANDBOX"
) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO repository_provisions VALUES ('default')"
  ).run()
  const stub = env[binding].getByName(`preview-test-${crypto.randomUUID()}`)
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

describe("Sandbox capacity", () => {
  const network = {
    repositories: [
      { remote: saved.remote, token: "t", scope: "read" as const },
    ],
    allowModel: false,
  }
  const leased = (objectId: string) =>
    env.DB.prepare("SELECT COUNT(*) FROM sandbox_leases WHERE object_id = ?")
      .bind(objectId)
      .first<number>("COUNT(*)")
  // The protected entry the preview path uses, which never waits for capacity.
  const start = (sandbox: ExecutionSandbox) =>
    (
      sandbox as unknown as {
        applyNetwork(network: unknown, waitMs: number): Promise<void>
      }
    ).applyNetwork(network, 0)

  it("refuses to start a container beyond the network's limit, then starts once a slot frees", async () => {
    await env.DB.prepare(
      "INSERT INTO sandbox_limits VALUES ('general', NULL, ?, ?)"
    )
      .bind(
        JSON.stringify({ agent: 10, agentless: 1 }),
        new Date().toISOString()
      )
      .run()
    await env.DB.prepare(
      "INSERT INTO sandbox_leases VALUES ('busy', 'default', 'WORKSPACE_SANDBOX', ?)"
    )
      .bind(Date.now() + 60_000)
      .run()
    try {
      await withSandbox(async (sandbox, f) => {
        f.container.running = false
        await expect(start(sandbox)).rejects.toThrow(
          "Sandbox capacity reached: this network already runs 1 agentless Sandbox."
        )
        expect(f.container.start).not.toHaveBeenCalled()

        await env.DB.prepare(
          "DELETE FROM sandbox_leases WHERE object_id = 'busy'"
        ).run()
        await start(sandbox)
        expect(f.container.start).toHaveBeenCalledOnce()
        const id = (sandbox as unknown as { ctx: DurableObjectState }).ctx.id
        expect(await leased(id.toString())).toBe(1)
        await sandbox.close()
        expect(await leased(id.toString())).toBe(0)
      })
    } finally {
      await env.DB.prepare("DELETE FROM sandbox_limits").run()
      await env.DB.prepare(
        "DELETE FROM sandbox_leases WHERE object_id = 'busy'"
      ).run()
    }
  })

  it("frees the slot when its container stops on its own", async () => {
    await withSandbox(async (sandbox, f) => {
      f.container.running = false
      await start(sandbox)
      const id = (sandbox as unknown as { ctx: DurableObjectState }).ctx.id
      expect(await leased(id.toString())).toBe(1)
      f.container.exit()
      await vi.waitFor(async () => expect(await leased(id.toString())).toBe(0))
    })
  })

  it("counts a container that was already running without asking for a slot", async () => {
    await withSandbox(async (sandbox) => {
      await sandbox.configure(network)
      const id = (sandbox as unknown as { ctx: DurableObjectState }).ctx.id
      expect(await leased(id.toString())).toBe(1)
      await sandbox.close()
    })
  })
})

describe("Sandbox namespaces", () => {
  const registered = (binding: string) =>
    env.DB.prepare(
      "SELECT COUNT(*) FROM network_sandboxes WHERE namespace='default' AND binding=?"
    )
      .bind(binding)
      .first<number>("COUNT(*)")

  it("registers each Sandbox under the binding its object id resolves in", async () => {
    for (const binding of ["SANDBOX", "WORKSPACE_SANDBOX"] as const) {
      const before = (await registered(binding)) ?? 0
      await withSandbox(async (sandbox) => {
        await sandbox.configure({
          repositories: [{ remote: saved.remote, token: "t", scope: "read" }],
          allowModel: false,
        })
      }, binding)
      expect(await registered(binding)).toBe(before + 1)
    }
  })

  it("never grants a WorkspaceSandbox model access", async () => {
    await withSandbox(async (sandbox, f) => {
      await expect(
        sandbox.configure({ repositories: [], allowModel: true })
      ).rejects.toThrow("never granted model access")
      expect(f.container.interceptAllOutboundHttp).not.toHaveBeenCalled()
    })
    await withSandbox(async (sandbox, f) => {
      await sandbox.configure({ repositories: [], allowModel: true })
      expect(f.container.interceptAllOutboundHttp).toHaveBeenCalledOnce()
    }, "SANDBOX")
  })
})

describe("Sandbox preview routing", () => {
  it("registers reused previews and permanently purges the container and stored data", async () => {
    await withSandbox(async (sandbox, f) => {
      await sandbox.prepareTrainPreview({ ...saved, hostname: "localhost" })
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) FROM network_sandboxes WHERE namespace='default'"
        ).first("COUNT(*)")
      ).toBeGreaterThan(0)
      f.container.destroy.mockImplementation(async () => {
        f.container.running = false
      })
      await sandbox.purge()
      expect(f.container.destroy).toHaveBeenCalledOnce()
      expect(
        (
          await sandbox.fetchTrainPreview(
            new Request("https://preview.test/"),
            saved.token
          )
        ).status
      ).toBe(404)
      await expect(
        sandbox.configure({ repositories: [], allowModel: false })
      ).rejects.toThrow("Sandbox was deleted")
    })
  })
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
