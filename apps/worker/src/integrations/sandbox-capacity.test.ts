import { parseRepoId } from "@terminus/artifacts"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { testPorts } from "../../test/fixtures"
import { createNetwork } from "../agents/dispatcher"
import {
  acquireSandboxLease,
  releaseSandboxLease,
  renewSandboxLease,
  sandboxLimit,
  type SandboxLease,
} from "./sandbox-capacity"

const ttl = 60_000
const lease = (
  objectId: string,
  namespace: string,
  binding: SandboxLease["binding"] = "SANDBOX"
): SandboxLease => ({ objectId, namespace, binding })
const live = (namespace: string, binding = "SANDBOX") =>
  env.DB.prepare(
    "SELECT COUNT(*) FROM sandbox_leases WHERE namespace = ? AND binding = ?"
  )
    .bind(namespace, binding)
    .first<number>("COUNT(*)")

describe("Sandbox capacity", () => {
  it("never grants more concurrent leases than the limit, even when starts race", async () => {
    const namespace = `race-${crypto.randomUUID()}`
    const now = Date.now()
    const granted = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        acquireSandboxLease(
          env.DB,
          lease(`race-${index}-${namespace}`, namespace),
          3,
          now,
          ttl
        )
      )
    )
    expect(granted.filter(Boolean)).toHaveLength(3)
    expect(await live(namespace)).toBe(3)
  })

  it("counts each kind and network separately, and a holder only once", async () => {
    const namespace = `kinds-${crypto.randomUUID()}`
    const other = `other-${crypto.randomUUID()}`
    const now = Date.now()
    const take = (objectId: string, space = namespace, binding = "SANDBOX") =>
      acquireSandboxLease(
        env.DB,
        lease(objectId, space, binding as SandboxLease["binding"]),
        1,
        now,
        ttl
      )
    expect(await take(`a-${namespace}`)).toBe(true)
    expect(await take(`a-${namespace}`)).toBe(true)
    expect(await take(`b-${namespace}`)).toBe(false)
    expect(await take(`c-${namespace}`, namespace, "WORKSPACE_SANDBOX")).toBe(
      true
    )
    expect(await take(`d-${namespace}`, other)).toBe(true)
    expect(await live(namespace)).toBe(1)
  })

  it("frees a slot on release, and lets an expired lease lapse", async () => {
    const namespace = `lapse-${crypto.randomUUID()}`
    const now = Date.now()
    const first = lease(`first-${namespace}`, namespace)
    const second = lease(`second-${namespace}`, namespace)
    expect(await acquireSandboxLease(env.DB, first, 1, now, ttl)).toBe(true)
    expect(await acquireSandboxLease(env.DB, second, 1, now, ttl)).toBe(false)
    await releaseSandboxLease(env.DB, first.objectId)
    expect(await acquireSandboxLease(env.DB, second, 1, now, ttl)).toBe(true)
    // Its container would have idled out by now, so the lease no longer counts.
    expect(
      await acquireSandboxLease(env.DB, first, 1, now + ttl + 1, ttl)
    ).toBe(true)
  })

  it("renews a running container's lease even above a lowered limit", async () => {
    const namespace = `renew-${crypto.randomUUID()}`
    const now = Date.now()
    const running = lease(`running-${namespace}`, namespace)
    expect(await acquireSandboxLease(env.DB, running, 1, now, ttl)).toBe(true)
    await renewSandboxLease(env.DB, running, now + ttl - 1, ttl)
    await renewSandboxLease(
      env.DB,
      lease(`orphan-${namespace}`, namespace),
      now,
      ttl
    )
    expect(await live(namespace)).toBe(2)
    expect(
      await acquireSandboxLease(
        env.DB,
        lease(`late-${namespace}`, namespace),
        1,
        now + ttl,
        ttl
      )
    ).toBe(false)
  })

  it("applies the network override, else General, else the defaults", async () => {
    const ports = testPorts()
    const network = await createNetwork(ports.dispatcher, { name: "Limits" })
    const { namespace } = parseRepoId(network.terminusRepoId)
    const limit = (binding: SandboxLease["binding"]) =>
      sandboxLimit(env.DB, { namespace, binding })
    expect([await limit("SANDBOX"), await limit("WORKSPACE_SANDBOX")]).toEqual([
      10, 10,
    ])
    const now = new Date().toISOString()
    await ports.store.setGeneralSandboxLimits({ agent: 3, agentless: 7 }, now)
    expect([await limit("SANDBOX"), await limit("WORKSPACE_SANDBOX")]).toEqual([
      3, 7,
    ])
    // A namespace still being onboarded has no network, so it follows General.
    expect(
      await sandboxLimit(env.DB, {
        namespace: "onboarding",
        binding: "SANDBOX",
      })
    ).toBe(3)
    await ports.store.setNetworkSandboxLimits(
      network.id,
      { agent: 25, agentless: 1 },
      now
    )
    expect([await limit("SANDBOX"), await limit("WORKSPACE_SANDBOX")]).toEqual([
      25, 1,
    ])
    await ports.store.setNetworkSandboxLimits(network.id, null, now)
    expect(await limit("SANDBOX")).toBe(3)
    await env.DB.prepare("DELETE FROM sandbox_limits").run()
  })
})
