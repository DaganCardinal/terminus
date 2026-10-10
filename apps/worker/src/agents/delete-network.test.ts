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
    expect(infra.order).toContain(`stop:${f.line.train.id}`)
    expect(infra.order).toContain("delete:plan-delete")
    for (const run of f.ports.runs) {
      expect(infra.order.indexOf(`stop:${run.runId}`)).toBeLessThan(
        infra.order.indexOf(`delete:${run.runId}`)
      )
    }
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

  it("purges registered random containers and previews before removing repositories and metadata", async () => {
    const f = await fixture()
    await env.DB.prepare(
      "INSERT INTO network_sandboxes VALUES ('random-conductor', ?)"
    )
      .bind(f.namespace)
      .run()
    const infra = workflows()
    const purged: string[] = []
    const stub = (id: string) => ({
      id: { toString: () => id },
      purge: vi.fn(async () => {
        purged.push(id)
      }),
    })
    const random = stub("random-conductor")
    random.purge.mockRejectedValueOnce(new Error("Container unavailable"))
    const testEnv = {
      ...infra.env,
      REPOSITORY_MODE: "artifacts",
      ARTIFACTS_ACCOUNT_ID: "test-account",
      ARTIFACTS_API_TOKEN: "test-token",
      SANDBOX: {
        idFromString: (id: string) => id,
        get: () => random,
        getByName: (name: string) => stub(name),
      },
    } as unknown as Env
    const removeRepositories = vi
      .spyOn(ArtifactsRestClient.prototype, "deleteRepositories")
      .mockImplementation(async (namespace) => {
        expect(namespace).toBe(f.namespace)
        expect(purged).toContain("random-conductor")
        expect(purged.some((id) => id.startsWith("preview-"))).toBe(true)
        expect(await f.ports.store.network(f.network.id)).not.toBeNull()
      })
    await expect(deleteNetwork(testEnv, f.network.id)).rejects.toMatchObject({
      status: 503,
    })
    expect(removeRepositories).not.toHaveBeenCalled()
    await deleteNetwork(testEnv, f.network.id)
    expect(removeRepositories).toHaveBeenCalledOnce()
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM network_sandboxes WHERE namespace=?"
      )
        .bind(f.namespace)
        .first("COUNT(*)")
    ).toBe(0)
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
