import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { ExecutionSandbox, SandboxContainer } from "./execution-sandbox"

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
    exec: vi.fn<
      (
        command: string[],
        options: { signal: AbortSignal }
      ) => Promise<{
        stdout: ReadableStream<Uint8Array>
        exitCode: Promise<number>
      }>
    >(async () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("filtered activity\n"))
          controller.close()
        },
      }),
      exitCode: Promise.resolve(0),
    })),
  }
  return { container, fetch }
}

const saved = {
  token: "b".repeat(24),
  commit: "a".repeat(40),
  remote: "https://account.artifacts.cloudflare.net/git/default/train.git",
}

// Previews run in agentless Sandboxes, so tests default to one of those
// containers. Each shares the name of the Sandbox it serves.
async function withSandbox(
  run: (
    sandbox: SandboxContainer,
    f: ReturnType<typeof fakeContainer>,
    name: string
  ) => Promise<void>,
  binding:
    | "SANDBOX_STANDARD_2"
    | "WORKSPACE_SANDBOX_STANDARD_1" = "WORKSPACE_SANDBOX_STANDARD_1"
) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO repository_provisions VALUES ('default')"
  ).run()
  const name = `preview-test-${crypto.randomUUID()}`
  const stub = env[binding].getByName(name)
  await runInDurableObject(stub, async (instance, state) => {
    // The test environment adds TEST_MIGRATIONS to Env; the bound production
    // class uses the generated Env without that test-only field.
    const sandbox = instance as unknown as SandboxContainer
    await state.storage.put("trainPreview", saved)
    const f = fakeContainer()
    // Keep native Durable Object storage/context; replace only its container transport.
    const mock = vi
      .spyOn(sandbox as unknown as { container(): Container }, "container")
      .mockReturnValue(f.container as unknown as Container)
    try {
      await run(sandbox, f, name)
    } finally {
      mock.mockRestore()
    }
  })
}

describe("Sandbox streaming commands", () => {
  it("streams stdout with the existing environment, EOF stdin and no stderr exposure", async () => {
    await withSandbox(async (sandbox, f) => {
      const ready = vi
        .spyOn(sandbox as unknown as { ready(): Promise<void> }, "ready")
        .mockResolvedValue()
      try {
        const output = await sandbox.runStream(
          ["node", "trusted-filter.mjs"],
          "/workspace/repo",
          { OPENCODE_CONFIG: "/workspace/opencode.json" }
        )
        expect(await new Response(output).text()).toBe("filtered activity\n")
        expect(f.container.exec).toHaveBeenCalledWith(
          ["node", "trusted-filter.mjs"],
          expect.objectContaining({
            cwd: "/workspace/repo",
            stderr: "ignore",
            env: expect.objectContaining({
              OPENCODE_CONFIG: "/workspace/opencode.json",
              GIT_TERMINAL_PROMPT: "0",
            }),
          })
        )
      } finally {
        ready.mockRestore()
      }
    })
  })

  it("aborts the command when a streaming caller cancels", async () => {
    await withSandbox(async (sandbox, f) => {
      const ready = vi
        .spyOn(sandbox as unknown as { ready(): Promise<void> }, "ready")
        .mockResolvedValue()
      f.container.exec.mockResolvedValueOnce({
        stdout: new ReadableStream<Uint8Array>(),
        exitCode: Promise.resolve(0),
      })
      try {
        const output = await sandbox.runStream(["node", "trusted-filter.mjs"])
        await output.cancel()
        expect(f.container.exec.mock.calls[0]![1].signal.aborted).toBe(true)
      } finally {
        ready.mockRestore()
      }
    })
  })
})

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
  const start = (sandbox: SandboxContainer) =>
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

  it("registers the Sandbox each container serves, by that Sandbox's id and binding", async () => {
    for (const [binding, container] of [
      ["SANDBOX", "SANDBOX_STANDARD_2"],
      ["WORKSPACE_SANDBOX", "WORKSPACE_SANDBOX_STANDARD_1"],
    ] as const) {
      const before = (await registered(binding)) ?? 0
      await withSandbox(async (sandbox, _f, name) => {
        await sandbox.configure({
          repositories: [{ remote: saved.remote, token: "t", scope: "read" }],
          allowModel: false,
        })
        expect(
          await env.DB.prepare(
            "SELECT binding FROM network_sandboxes WHERE object_id = ?"
          )
            .bind(env[binding].idFromName(name).toString())
            .first("binding")
        ).toBe(binding)
      }, container)
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
    }, "SANDBOX_STANDARD_2")
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

describe("Sandbox sizes", () => {
  const network = {
    repositories: [
      { remote: saved.remote, token: "t", scope: "read" as const },
    ],
    allowModel: false,
  }
  const useSizes = (agentless: string) =>
    env.DB.prepare(
      "INSERT INTO sandbox_limits VALUES ('general', NULL, ?, ?) ON CONFLICT(scope) DO UPDATE SET limits = excluded.limits"
    )
      .bind(
        JSON.stringify({
          agent: 10,
          agentless: 10,
          sizes: { agent: "standard-2", agentless },
        }),
        new Date().toISOString()
      )
      .run()

  /** Runs inside a Sandbox, with a fake container stub per size. */
  async function withRouter(
    run: (
      sandbox: ExecutionSandbox,
      containers: Record<string, ReturnType<typeof fakeStub>>,
      state: DurableObjectState,
      names: Set<string>
    ) => Promise<void>
  ) {
    const stub = env.WORKSPACE_SANDBOX.getByName(`sized-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (instance, state) => {
      const sandbox = instance as unknown as ExecutionSandbox
      const containers: Record<string, ReturnType<typeof fakeStub>> = {}
      const names = new Set<string>()
      const mock = vi
        .spyOn(
          sandbox as unknown as {
            container(size: string, name: string): unknown
          },
          "container"
        )
        .mockImplementation((size, name) => {
          names.add(name)
          return (containers[size] ??= fakeStub())
        })
      try {
        await run(sandbox, containers, state, names)
      } finally {
        mock.mockRestore()
      }
    })
  }
  function fakeStub() {
    const stub = {
      isRunning: false,
      running: vi.fn(async () => stub.isRunning),
      configure: vi.fn(async () => {
        stub.isRunning = true
      }),
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
      })),
      fetchTrainPreview: vi.fn(async () => new Response("preview")),
      close: vi.fn(async () => {
        stub.isRunning = false
      }),
      purge: vi.fn(async () => {}),
    }
    return stub
  }

  it("starts at the network's size, and changes size only once no container runs", async () => {
    await useSizes("standard-3")
    try {
      await withRouter(async (sandbox, containers) => {
        await sandbox.configure(network)
        expect(containers["standard-3"]!.configure).toHaveBeenCalledOnce()

        // A running container keeps its size, so its workspace survives.
        await useSizes("standard-2")
        await sandbox.configure(network)
        await sandbox.run(["true"])
        expect(containers["standard-3"]!.configure).toHaveBeenCalledTimes(2)
        expect(containers["standard-3"]!.run).toHaveBeenCalledOnce()
        expect(containers["standard-2"]).toBeUndefined()

        await sandbox.close()
        expect(containers["standard-3"]!.close).toHaveBeenCalledOnce()
        await sandbox.configure(network)
        await sandbox.run(["true"])
        expect(containers["standard-2"]!.configure).toHaveBeenCalledOnce()
        expect(containers["standard-2"]!.run).toHaveBeenCalledOnce()
      })
    } finally {
      await env.DB.prepare("DELETE FROM sandbox_limits").run()
    }
  })

  it("refuses work and previews before any container has started", async () => {
    await withRouter(async (sandbox, containers) => {
      await expect(sandbox.run(["true"])).rejects.toThrow(
        "Sandbox network capabilities have not been configured"
      )
      const response = await sandbox.fetchTrainPreview(
        new Request("https://preview.test/"),
        saved.token
      )
      expect(response.status).toBe(404)
      await sandbox.close()
      expect(Object.keys(containers)).toEqual([])
    })
  })

  it("names every size's container after the Sandbox, and purges them all with its storage", async () => {
    await withRouter(async (sandbox, containers, state, names) => {
      await sandbox.configure(network)
      const id = (sandbox as unknown as { ctx: DurableObjectState }).ctx.id
      expect([...names]).toEqual([id.name])
      await sandbox.purge()
      for (const size of ["standard-1", "standard-2", "standard-3"])
        expect(containers[size]!.purge).toHaveBeenCalledOnce()
      expect(await state.storage.list()).toEqual(new Map())
      await expect(sandbox.configure(network)).rejects.toThrow(
        "Sandbox was deleted"
      )
    })
  })
})
