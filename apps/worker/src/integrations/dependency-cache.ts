import { perf, type CommandResult } from "@terminus/protocol"

/** npm's download cache in every Sandbox, set for all commands through the environment. */
export const npmCacheDirectory = "/var/cache/npm"

/** The dependency install orchestration runs in every Sandbox. */
export const installCommand = [
  "npm",
  "ci",
  "--no-audit",
  "--no-fund",
  "--prefer-offline",
]

/** Bump to discard every cached entry, e.g. after an npm cache format change. */
const keyPrefix = "npm/v1/"
const scratch = "/tmp/dependency-cache"
const archive = "/tmp/dependency-cache.tar"

export interface CacheContainer {
  /** Runs a command to completion, returning its bounded text output. */
  run(command: string[], cwd?: string): Promise<CommandResult>
  /** Runs a command with streamed stdin or stdout. */
  stream(
    command: string[],
    stdin?: ReadableStream
  ): Promise<{ stdout: ReadableStream | null; exitCode: Promise<number> }>
}

type CacheOutcome = "hit" | "stored" | "miss" | "discarded"

/**
 * Installs dependencies with npm's download cache restored from R2, keyed by
 * the lockfile's hash, so tarballs are fetched once per lockfile rather than
 * once per Sandbox.
 *
 * On a miss the cache is filled by `npm ci --ignore-scripts` in a scratch copy
 * of only `package.json` and the lockfile, and stored before the real install.
 * No repository code has run in the container when it is stored. npm also
 * verifies every cached tarball against the lockfile's integrity hashes, so a
 * cache can slow an install down but never change what it installs. A cache
 * is only ever a speedup: any failure falls back to a plain install.
 */
export async function installDependencies(
  container: CacheContainer,
  bucket: R2Bucket,
  cwd: string
): Promise<CommandResult> {
  const started = Date.now()
  const key = await lockfileKey(container, cwd)
  const keyMs = Date.now() - started
  let outcome: CacheOutcome = "miss"
  if (key && (await restore(container, bucket, key))) outcome = "hit"
  else if (key && (await store(container, bucket, cwd, key))) outcome = "stored"
  const cacheMs = Date.now() - started - keyMs
  const ciStarted = Date.now()
  let installed = await container.run(installCommand, cwd)
  const ciMs = Date.now() - ciStarted
  if (outcome === "hit" && installed.exitCode !== 0) {
    // Only a restored cache could have caused this; retry from the registry.
    await container.run(["rm", "-rf", npmCacheDirectory])
    installed = await container.run(installCommand, cwd)
    if (installed.exitCode === 0) {
      outcome = "discarded"
      await bucket.delete(key!)
    }
  }
  console.info("Dependency install completed", {
    cache: outcome,
    durationMs: Date.now() - started,
    exitCode: installed.exitCode,
  })
  // TEMPORARY benchmark instrumentation.
  perf("dependencies.install", {
    cwd,
    cache: outcome,
    ms: Date.now() - started,
    keyMs,
    cacheMs,
    ciMs,
    exitCode: installed.exitCode,
  })
  return installed
}

async function lockfileKey(
  container: CacheContainer,
  cwd: string
): Promise<string | null> {
  const result = await container.run(["sha256sum", "package-lock.json"], cwd)
  const hash = /^([0-9a-f]{64})\s/.exec(result.stdout)?.[1]
  return result.exitCode === 0 && hash ? `${keyPrefix}${hash}.tar` : null
}

async function restore(
  container: CacheContainer,
  bucket: R2Bucket,
  key: string
): Promise<boolean> {
  const fetched = Date.now()
  const object = await bucket.get(key)
  if (!object) return false
  perf("dependencies.cache_object", {
    key: key.slice(-16),
    mb: Math.round((object.size / 1048576) * 10) / 10,
    getMs: Date.now() - fetched,
  })
  await container.run(["mkdir", "-p", npmCacheDirectory])
  const extracted = await container.stream(
    ["tar", "-xf", "-", "--no-same-owner", "-C", npmCacheDirectory],
    object.body
  )
  if ((await extracted.exitCode) === 0) return true
  await container.run(["rm", "-rf", npmCacheDirectory])
  return false
}

async function store(
  container: CacheContainer,
  bucket: R2Bucket,
  cwd: string,
  key: string
): Promise<boolean> {
  try {
    // Start empty, so only this scripts-free install fills the cache.
    for (const command of [
      ["rm", "-rf", npmCacheDirectory, scratch, archive],
      ["mkdir", "-p", scratch],
      ["cp", "package.json", "package-lock.json", scratch],
    ])
      if ((await container.run(command, cwd)).exitCode !== 0) return false
    const filled = await container.run(
      ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      scratch
    )
    if (filled.exitCode !== 0) return false
    const packed = await container.run([
      "tar",
      "-cf",
      archive,
      "-C",
      npmCacheDirectory,
      "_cacache",
    ])
    const size = Number(
      (await container.run(["stat", "-c", "%s", archive])).stdout.trim()
    )
    if (packed.exitCode !== 0 || !Number.isSafeInteger(size) || size <= 0)
      return false
    // R2 needs the length of a streamed upload up front.
    const { readable, writable } = new FixedLengthStream(size)
    const read = await container.stream(["cat", archive])
    if (!read.stdout) return false
    await Promise.all([bucket.put(key, readable), read.stdout.pipeTo(writable)])
    if ((await read.exitCode) !== 0) {
      await bucket.delete(key)
      return false
    }
    return true
  } catch (error) {
    console.error("Dependency cache store failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  } finally {
    await container.run(["rm", "-rf", scratch, archive]).catch(() => {})
  }
}
