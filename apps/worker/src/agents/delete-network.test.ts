import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactsRestClient, parseRepoId } from "@terminus/artifacts"
import { seedLine, seedNetwork, testPorts, drive } from "../../test/fixtures"
import { handleApi } from "../api/router"
import { NetworkDeletionStore } from "../integrations/network-deletion-store"
import { createWorkflow } from "../integrations/workflow-start"
import { deleteNetwork } from "./delete-network"

afterEach(() => vi.restoreAllMocks())

function workflows() {
  const order: string[] = []
  const bindings = Object.fromEntries(
    [
      "TRAIN_WORKFLOW",
      "STATION_WORKFLOW",
      "DISPATCH_WORKFLOW",
      "TECHNICIAN_WORKFLOW",
      "INTEGRATION_WORKFLOW",
      "JUNCTION_WORKFLOW",
    ].map((name) => [
      name,
      {
        get: vi.fn(async (id: string) => {
          let status = "running"
          return {
            status: async () => ({ status }),
            terminate: async () => {
              order.push(`stop:${id}`)
              status = "terminated"
            },
            delete: async () => {
              order.push(`delete:${id}`)
            },
          }
        }),
      },
    ])
  )
  return { env: { ...env, ...bindings } as Env, bindings, order }
}

async function fixture() {
  const ports = testPorts()
  const network = await seedNetwork(ports)
  const line = await seedLine(ports, network.id)
  await drive(ports, line.train.id)
  const namespace = parseRepoId(network.terminusRepoId).namespace
  return { ports, network, line, namespace }
}

describe("permanent Network deletion", () => {
  it("stops and deletes every run, erases accepted work and history, and preserves another Network", async () => {
    const f = await fixture()
    const other = await seedNetwork(f.ports)
    await seedLine(f.ports, other.id)
    const otherSnapshot = await f.ports.store.snapshot(other.id)
    const infra = workflows()
    await env.DB.prepare(
      "INSERT INTO dispatch_plans VALUES (?, ?, 'planning', '{}', 0)"
    )
      .bind("plan-delete", f.network.id)
      .run()
    await deleteNetwork(infra.env, f.network.id)
    expect(infra.order).toContain(`delete:${f.line.train.id}`)
    expect(infra.order).toContain("delete:plan-delete")
    for (const run of f.ports.runs)
      expect(infra.order).toContain(`delete:${run.runId}`)
    // Deleting stops a running instance, so none is terminated first.
    expect(infra.order.filter((entry) => entry.startsWith("stop:"))).toEqual([])
    expect(await f.ports.store.network(f.network.id)).toBeNull()
    for (const table of [
      "lines",
      "trains",
      "stations",
      "cars",
      "agent_runs",
      "conductor_reviews",
      "dispatch_plans",
      "events",
      "execution_configs",
    ])
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE network_id = ?`
        )
          .bind(f.network.id)
          .first("count")
      ).toBe(0)
    expect(await f.ports.store.snapshot(other.id)).toEqual(otherSnapshot)
    await deleteNetwork(infra.env, f.network.id)
  })

  it("keeps a deletion fence on failure, blocks commands and stale writes, then allows retry", async () => {
    const f = await fixture()
    const infra = workflows()
    const get = vi.mocked(infra.env.TRAIN_WORKFLOW.get)
    get.mockRejectedValueOnce(new Error("Cloudflare unavailable"))
    await expect(deleteNetwork(infra.env, f.network.id)).rejects.toMatchObject({
      status: 503,
    })
    expect((await f.ports.store.network(f.network.id))!.deleting).toBe(true)
    const before = await f.ports.store.lastSeq(f.network.id)
    const response = await handleApi(
      new Request(
        `https://terminus.test/api/networks/${f.network.id}/emergency-brake`,
        { method: "POST", body: "{}" }
      ),
      infra.env
    )
    expect(response.status).toBe(409)
    await expect(
      env.DB.prepare("INSERT INTO holds VALUES ('late-hold', ?, '{}')")
        .bind(f.network.id)
        .run()
    ).rejects.toThrow("network_deleting")
    await expect(
      env.DB.prepare("UPDATE trains SET version=version+1 WHERE id=?")
        .bind(f.line.train.id)
        .run()
    ).rejects.toThrow("network_deleting")
    expect(await f.ports.store.lastSeq(f.network.id)).toBe(before)
    await deleteNetwork(infra.env, f.network.id)
    expect(await f.ports.store.network(f.network.id)).toBeNull()
  })

  it("counts a Workflow that is already gone as deleted, and reports any other failure", async () => {
    const f = await fixture()
    const infra = workflows()
    await env.DB.prepare(
      "INSERT INTO dispatch_plans VALUES (?, ?, 'planning', '{}', 0)"
    )
      .bind("plan-stuck", f.network.id)
      .run()
    const gone = () => {
      throw new Error("Instance does not exist")
    }
    vi.mocked(infra.env.TRAIN_WORKFLOW.get).mockImplementationOnce(gone)
    // Gone between lookup and deletion, such as after an earlier attempt.
    vi.mocked(infra.env.STATION_WORKFLOW.get).mockResolvedValue({
      delete: async () => gone(),
    } as unknown as WorkflowInstance)
    vi.mocked(infra.env.DISPATCH_WORKFLOW.get).mockResolvedValueOnce({
      delete: async () => {
        throw new Error("Cloudflare unavailable")
      },
    } as unknown as WorkflowInstance)
    await expect(deleteNetwork(infra.env, f.network.id)).rejects.toMatchObject({
      status: 503,
      details: [{ resource: "plan-stuck", action: "stop and delete Workflow" }],
    })
    await deleteNetwork(infra.env, f.network.id)
    expect(infra.order).toContain("delete:plan-stuck")
    expect(await f.ports.store.network(f.network.id)).toBeNull()
  })

  it("purges only registered Sandboxes before removing repositories and metadata", async () => {
    const f = await fixture()
    await env.DB.prepare(
      "INSERT INTO network_sandboxes (object_id, namespace) VALUES ('random-conductor', ?)"
    )
      .bind(f.namespace)
      .run()
    await env.DB.prepare(
      "INSERT INTO network_sandboxes (object_id, namespace, binding) VALUES ('random-git', ?, 'WORKSPACE_SANDBOX')"
    )
      .bind(f.namespace)
      .run()
    const infra = workflows()
    const purged: string[] = []
    const stub = (binding: string, id: string) => ({
      purge: vi.fn(async () => {
        purged.push(`${binding}:${id}`)
      }),
    })
    const random = stub("SANDBOX", "random-conductor")
    random.purge.mockRejectedValueOnce(new Error("Container unavailable"))
    // An object id only resolves in the namespace it was registered under.
    const namespace = (
      binding: string,
      registered: string,
      saved = stub(binding, registered)
    ) => ({
      idFromString: (id: string) => {
        if (id !== registered) throw new Error(`${id} is not a ${binding} id`)
        return id
      },
      get: () => saved,
      // A Sandbox addressed by a guessed name, such as a Station's or a
      // preview's, wakes its containers even if it never ran.
      getByName: vi.fn(),
    })
    const SANDBOX = namespace("SANDBOX", "random-conductor", random)
    const WORKSPACE_SANDBOX = namespace("WORKSPACE_SANDBOX", "random-git")
    const testEnv = {
      ...infra.env,
      REPOSITORY_MODE: "artifacts",
      ARTIFACTS_ACCOUNT_ID: "test-account",
      ARTIFACTS_API_TOKEN: "test-token",
      SANDBOX,
      WORKSPACE_SANDBOX,
    } as unknown as Env
    const removeRepositories = vi
      .spyOn(ArtifactsRestClient.prototype, "deleteRepositories")
      .mockImplementation(async (namespace) => {
        expect(namespace).toBe(f.namespace)
        expect(new Set(purged)).toEqual(
          new Set(["SANDBOX:random-conductor", "WORKSPACE_SANDBOX:random-git"])
        )
        expect(await f.ports.store.network(f.network.id)).not.toBeNull()
      })
    await expect(deleteNetwork(testEnv, f.network.id)).rejects.toMatchObject({
      status: 503,
    })
    expect(removeRepositories).not.toHaveBeenCalled()
    await deleteNetwork(testEnv, f.network.id)
    expect(removeRepositories).toHaveBeenCalledOnce()
    expect(SANDBOX.getByName).not.toHaveBeenCalled()
    expect(WORKSPACE_SANDBOX.getByName).not.toHaveBeenCalled()
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM network_sandboxes WHERE namespace=?"
      )
        .bind(f.namespace)
        .first("COUNT(*)")
    ).toBe(0)
    expect(await f.ports.store.network(f.network.id)).toBeNull()
  })

  it("purges registered Sandboxes a few at a time", async () => {
    const f = await fixture()
    const ids = Array.from({ length: 20 }, (_, at) => `sandbox-${at}`)
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          "INSERT INTO network_sandboxes (object_id, namespace) VALUES (?, ?)"
        ).bind(id, f.namespace)
      )
    )
    const purged: string[] = []
    let active = 0
    let peak = 0
    const sandboxes = {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        purge: async () => {
          peak = Math.max(peak, ++active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active--
          purged.push(id)
        },
      }),
    }
    vi.spyOn(
      ArtifactsRestClient.prototype,
      "deleteRepositories"
    ).mockResolvedValue()
    await deleteNetwork(
      {
        ...workflows().env,
        REPOSITORY_MODE: "artifacts",
        ARTIFACTS_ACCOUNT_ID: "test-account",
        ARTIFACTS_API_TOKEN: "test-token",
        SANDBOX: sandboxes,
        WORKSPACE_SANDBOX: sandboxes,
      } as unknown as Env,
      f.network.id
    )
    expect(purged.sort()).toEqual(ids.sort())
    expect(peak).toBe(6)
    expect(await f.ports.store.network(f.network.id)).toBeNull()
  })

  it("removes a Workflow created in flight after deletion starts", async () => {
    const f = await fixture()
    const remove = vi.fn(async () => {})
    const create = vi.fn(async () => {
      await new NetworkDeletionStore(env.DB).begin(f.network.id)
      return { delete: remove }
    })
    await expect(
      createWorkflow(
        env,
        { create } as unknown as Workflow,
        "trains",
        f.line.train.id,
        { id: f.line.train.id }
      )
    ).rejects.toThrow("network_deleting")
    expect(remove).toHaveBeenCalledOnce()
    await expect(
      createWorkflow(
        env,
        { create } as unknown as Workflow,
        "trains",
        f.line.train.id,
        { id: f.line.train.id }
      )
    ).rejects.toThrow("network_deleting")
    expect(create).toHaveBeenCalledOnce()
  })

  it("requires explicit permanent-deletion intent in the API", async () => {
    const f = await fixture()
    const infra = workflows()
    for (const body of [
      {},
      { confirm: false },
      { confirm: true, archive: true },
    ]) {
      const response = await handleApi(
        new Request(`https://terminus.test/api/networks/${f.network.id}`, {
          method: "DELETE",
          body: JSON.stringify(body),
        }),
        infra.env
      )
      expect(response.status).toBe(400)
    }
    expect(
      (await f.ports.store.network(f.network.id))!.deleting
    ).toBeUndefined()
    expect(
      (
        await handleApi(
          new Request(`https://terminus.test/api/networks/${f.network.id}`, {
            method: "DELETE",
            body: '{"confirm":true}',
          }),
          infra.env
        )
      ).status
    ).toBe(204)
  })
})
