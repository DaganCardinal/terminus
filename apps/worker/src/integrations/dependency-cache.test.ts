import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommandResult } from "@terminus/protocol"
import {
  installCommand,
  installDependencies,
  type CacheContainer,
} from "./dependency-cache"

const hash = "f".repeat(64)
const key = `npm/v1/${hash}.tar`
const repo = "/workspace/repo"
const archive = "cached tarballs"

afterEach(async () => {
  await env.DEPENDENCY_CACHE.delete(key)
  vi.restoreAllMocks()
})

/** A scripted container that records each command in order. */
function container(
  options: {
    lockfile?: boolean
    fillExit?: number
    installExits?: number[]
  } = {}
) {
  const log: string[] = []
  let extracted = ""
  const installExits = [...(options.installExits ?? [])]
  const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" }
  const sandbox: CacheContainer = {
    run: vi.fn(async (command: string[], cwd?: string) => {
      log.push(`${command.join(" ")}${cwd ? ` @${cwd}` : ""}`)
      if (command[0] === "sha256sum")
        return options.lockfile === false
          ? { ...ok, exitCode: 1 }
          : { ...ok, stdout: `${hash}  package-lock.json\n` }
      if (command.includes("--ignore-scripts"))
        return { ...ok, exitCode: options.fillExit ?? 0 }
      if (command[0] === "stat") return { ...ok, stdout: `${archive.length}\n` }
      if (command.join(" ") === installCommand.join(" "))
        return { ...ok, exitCode: installExits.shift() ?? 0 }
      return ok
    }),
    stream: vi.fn(async (command: string[], stdin?: ReadableStream) => {
      log.push(`${command.join(" ")} (streamed)`)
      if (stdin) extracted = await new Response(stdin).text()
      return {
        stdout: stdin ? null : new Response(archive).body,
        exitCode: Promise.resolve(0),
      }
    }),
  }
  return { sandbox, log, extracted: () => extracted }
}

describe("dependency cache", () => {
  it("fills a missing cache without repository scripts, stores it, then installs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const f = container()
    const result = await installDependencies(
      f.sandbox,
      env.DEPENDENCY_CACHE,
      repo
    )
    expect(result.exitCode).toBe(0)
    expect(await (await env.DEPENDENCY_CACHE.get(key))!.text()).toBe(archive)
    const at = (prefix: string) =>
      f.log.findIndex((entry) => entry.startsWith(prefix))
    // Only the manifest and lockfile are copied, into a scratch directory.
    expect(f.log).toContain(
      `cp package.json package-lock.json /tmp/dependency-cache @${repo}`
    )
    expect(f.log).toContain(
      "npm ci --ignore-scripts --no-audit --no-fund @/tmp/dependency-cache"
    )
    // The cache starts empty and is stored before any repository install.
    expect(at("rm -rf /var/cache/npm")).toBeLessThan(at("npm ci --ignore"))
    expect(at("cat /tmp/dependency-cache.tar")).toBeLessThan(
      f.log.indexOf(`${installCommand.join(" ")} @${repo}`)
    )
    expect(info).toHaveBeenCalledWith(
      "Dependency install completed",
      expect.objectContaining({ cache: "stored", exitCode: 0 })
    )
  })

  it("restores a cached lockfile instead of filling it again", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    await env.DEPENDENCY_CACHE.put(key, archive)
    const f = container()
    await installDependencies(f.sandbox, env.DEPENDENCY_CACHE, repo)
    expect(f.extracted()).toBe(archive)
    expect(f.log).toContain(
      "tar -xf - --no-same-owner -C /var/cache/npm (streamed)"
    )
    expect(f.log.some((entry) => entry.includes("--ignore-scripts"))).toBe(
      false
    )
    expect(f.log.at(-1)).toBe(`${installCommand.join(" ")} @${repo}`)
    expect(info).toHaveBeenCalledWith(
      "Dependency install completed",
      expect.objectContaining({ cache: "hit" })
    )
  })

  it("discards a cache that broke an install the registry alone completes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    await env.DEPENDENCY_CACHE.put(key, archive)
    const f = container({ installExits: [1, 0] })
    const result = await installDependencies(
      f.sandbox,
      env.DEPENDENCY_CACHE,
      repo
    )
    expect(result.exitCode).toBe(0)
    expect(await env.DEPENDENCY_CACHE.get(key)).toBeNull()
    expect(f.log.slice(-2)).toEqual([
      "rm -rf /var/cache/npm",
      `${installCommand.join(" ")} @${repo}`,
    ])
  })

  it("keeps the cache when the project itself fails to install", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    await env.DEPENDENCY_CACHE.put(key, archive)
    const f = container({ installExits: [1, 1] })
    expect(
      (await installDependencies(f.sandbox, env.DEPENDENCY_CACHE, repo))
        .exitCode
    ).toBe(1)
    expect(await env.DEPENDENCY_CACHE.get(key)).not.toBeNull()
  })

  it("installs normally without a lockfile or when the cache cannot be filled", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const unlocked = container({ lockfile: false })
    await installDependencies(unlocked.sandbox, env.DEPENDENCY_CACHE, repo)
    expect(unlocked.log).toEqual([
      `sha256sum package-lock.json @${repo}`,
      `${installCommand.join(" ")} @${repo}`,
    ])
    const unfillable = container({ fillExit: 1 })
    expect(
      (
        await installDependencies(
          unfillable.sandbox,
          env.DEPENDENCY_CACHE,
          repo
        )
      ).exitCode
    ).toBe(0)
    expect(await env.DEPENDENCY_CACHE.get(key)).toBeNull()
    expect(unfillable.log.at(-1)).toBe(`${installCommand.join(" ")} @${repo}`)
  })
})
