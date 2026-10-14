import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  PIPELINE_STRESS_PROFILE,
  stressLines,
  stressRunSchema,
  stressLaunchSchema,
  stressStatusSchema,
  stressVerificationSchema,
} from "../../../packages/protocol/src/stress-test.ts"
import {
  stressTimings,
  latencySummary,
  phaseTimings,
  type TimingEvent,
} from "./report.ts"

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    network: { type: "string" },
    output: { type: "string" },
    observe: { type: "string" },
    "dry-run": { type: "boolean" },
    "timeout-minutes": { type: "string", default: "30" },
    help: { type: "boolean" },
  },
})
if (
  !values.help &&
  !values["dry-run"] &&
  !values.observe &&
  !values["base-url"] &&
  !values.network &&
  !values.output
) {
  console.log(
    "Running the local ten-Train rehearsal and real local Git oracle. No Cloudflare account, Docker, or Access token is needed. For Cloudflare verification, use Stress test in the app."
  )
  const child = spawn("npm", ["run", "stress:offline"], {
    cwd: resolve(import.meta.dirname, "../../.."),
    stdio: "inherit",
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  process.exit(code)
}
if (values.help) {
  console.log(
    "npm run stress:ten -- --base-url URL --network OPTIONAL_EMPTY_NETWORK_ID [--output DIR] [--timeout-minutes 30]\n--dry-run writes the scenario without contacting a Worker.\n--observe RUN_DIRECTORY resumes monitoring without launching any Lines.\nOptional Cloudflare Access login JWT: CF_ACCESS_TOKEN."
  )
  process.exit(0)
}

const networkSchema = z
  .object({
    id: z.string(),
    terminusCommit: z.string(),
    validation: z
      .array(z.object({ name: z.string(), command: z.array(z.string()) }))
      .optional(),
  })
  .passthrough()
const snapshotSchema = z
  .object({
    network: networkSchema,
    lines: z.array(z.unknown()),
    stations: z.array(
      z
        .object({
          id: z.string(),
          revisionCount: z.number(),
          runRetries: z.number().optional(),
          state: z.object({ status: z.string() }).passthrough(),
        })
        .passthrough()
    ),
    trains: z.array(
      z
        .object({
          train: z
            .object({
              id: z.string(),
              state: z
                .object({ status: z.string(), phase: z.string().optional() })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough()
    ),
    cars: z.array(z.object({ acceptedCommit: z.string() }).passthrough()),
    holds: z.array(z.unknown()),
    plans: z.array(z.unknown()),
    conflicts: z.array(z.unknown()),
    junctions: z.array(z.unknown()).optional(),
    lastSeq: z.number(),
  })
  .passthrough()
const eventsSchema = z.object({
  events: z.array(
    z.object({
      seq: z.number(),
      occurredAt: z.string(),
      event: z
        .object({ type: z.string(), trainId: z.string().optional() })
        .passthrough(),
    })
  ),
  lastSeq: z.number(),
})
const stateSchema = stressRunSchema.extend({
  profile: z.literal(PIPELINE_STRESS_PROFILE),
  baseUrl: z.url(),
  networkId: z.string(),
  baseline: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  startedAt: z.string(),
  releasedAt: z.string().optional(),
  launchComplete: z.boolean().optional(),
})
const minutes = Number(values["timeout-minutes"])
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180)
  throw new Error("Timeout must be between 0 and 180 minutes")
const output = resolve(
  values.observe ??
    values.output ??
    `stress-runs/${new Date().toISOString().replaceAll(":", "-")}`
)
await mkdir(output, { recursive: true })
const state: z.infer<typeof stateSchema> = values.observe
  ? stateSchema.parse(JSON.parse(await readFile(`${output}/run.json`, "utf8")))
  : {
      profile: PIPELINE_STRESS_PROFILE,
      runId: randomUUID(),
      baseUrl: values["base-url"] ?? "http://localhost:8787",
      networkId: values.network ?? "",
      startedAt: new Date().toISOString(),
    }
const base = new URL(state.baseUrl)
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
)
  throw new Error("Use an application origin as --base-url")
const save = async (name: string, data: unknown) => {
  const target = `${output}/${name}.json`
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`)
  await rename(temporary, target)
}
const lines = stressLines(state.runId)
if (!values.observe) {
  // Exclusive creation prevents accidental replacement of a previous run journal.
  await writeFile(`${output}/run.json`, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  })
  await save("scenario", { profile: state.profile, runId: state.runId, lines })
}
if (values["dry-run"]) {
  console.log(`Wrote ten-Line scenario to ${output}/scenario.json`)
  process.exit(0)
}
const accessToken = process.env.CF_ACCESS_TOKEN
if (
  accessToken &&
  !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)
)
  throw new Error("CF_ACCESS_TOKEN must be a Cloudflare Access login JWT")
const samples: { path: string; method: string; ms: number; ok: boolean }[] = []
async function api(
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  const start = performance.now()
  let ok = false
  try {
    const response = await fetch(new URL(`/api${path}`, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
      headers: {
        "content-type": "application/json",
        ...(accessToken
          ? {
              cookie: `CF_Authorization=${accessToken}`,
              "cf-access-jwt-assertion": accessToken,
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      // The Worker's message and findings name the failed checks and Trains.
      let reason = ""
      try {
        const body = JSON.parse(text) as {
          error?: unknown
          details?: { findings?: unknown }
        }
        const findings = body.details?.findings
        reason = Array.isArray(findings)
          ? findings.map(String).join("\n  ")
          : typeof body.error === "string"
            ? body.error
            : ""
      } catch {
        reason = text.slice(0, 500)
      }
      throw new Error(
        `${method} ${path.split("?")[0]} returned ${response.status}${reason ? `:\n  ${reason}` : ""}`
      )
    }
    ok = true
    return text ? JSON.parse(text) : null
  } finally {
    samples.push({
      path: path.split("?")[0],
      method,
      ms: performance.now() - start,
      ok,
    })
  }
}
let networkPath = `/networks/${encodeURIComponent(state.networkId)}`
const events: (TimingEvent & { seq: number })[] = values.observe
  ? eventsSchema.shape.events.parse(
      JSON.parse(
        await readFile(`${output}/events.json`, "utf8").catch(() => "[]")
      )
    )
  : []
let snapshot: z.infer<typeof snapshotSchema> | undefined
let status: z.infer<typeof stressStatusSchema> | undefined
let verification: z.infer<typeof stressVerificationSchema> | undefined
const observed: unknown[] = []
const deadline = Date.now() + minutes * 60_000
let failure: string | undefined
try {
  z.object({
    profile: z.literal(PIPELINE_STRESS_PROFILE),
    repositoryMode: z.literal("artifacts"),
  }).parse(await api("/stress-test"))
  if (!values.observe) {
    const launched = stressLaunchSchema.parse(
      await api("/stress-tests", "POST", {
        requestId: state.runId,
        ...(state.networkId ? { networkId: state.networkId } : {}),
      })
    )
    state.networkId = launched.networkId
    state.baseline = launched.baseline
    state.launchComplete = true
    state.releasedAt = new Date().toISOString()
    networkPath = `/networks/${encodeURIComponent(state.networkId)}`
    await save("run", state)
  } else if (!state.launchComplete || !state.releasedAt) {
    throw new Error(
      "Launch was interrupted. Retry its saved request ID through the stress-test command; monitoring never replays mutations."
    )
  }
  while (Date.now() < deadline) {
    snapshot = snapshotSchema.parse(await api(networkPath))
    status = stressStatusSchema.parse(await api(`${networkPath}/stress-test`))
    let page: z.infer<typeof eventsSchema>
    do {
      page = eventsSchema.parse(
        await api(`${networkPath}/events?after=${events.at(-1)?.seq ?? 0}`)
      )
      events.push(...page.events)
    } while (page.events.length)
    await save("events", events)
    observed.push({
      at: new Date().toISOString(),
      states: snapshot.trains.map(({ train }) => ({
        id: train.id,
        ...train.state,
      })),
      ...status,
      eventSequenceLag: Math.max(
        0,
        snapshot.lastSeq - (events.at(-1)?.seq ?? 0)
      ),
      latestEventAgeMs: events.length
        ? Math.max(0, Date.now() - Date.parse(events.at(-1)!.occurredAt))
        : null,
    })
    const completed = snapshot.trains.filter(
      ({ train }) => train.state.status === "unloaded"
    ).length
    console.log(
      `${completed}/10 unloaded; ${snapshot.trains.filter(({ train }) => train.state.status === "returning" && train.state.phase === "awaiting_clearance").length} queued; ${status.leases} Sandbox leases`
    )
    if (
      snapshot.trains.some(({ train }) =>
        ["blocked", "siding"].includes(train.state.status)
      ) ||
      status.failedIntegrations
    )
      throw new Error(
        "Unexpected blocker or integration failure; inspect report.json and the Network"
      )
    if (
      completed === 10 &&
      status.leases === 0 &&
      status.activeIntegrations === 0
    ) {
      verification = stressVerificationSchema.parse(
        await api(`${networkPath}/stress-test/verify`, "POST", {
          runId: state.runId,
          baseline: state.baseline,
        })
      )
      status = stressStatusSchema.parse(await api(`${networkPath}/stress-test`))
      // Expired lease rows belong to stopped Sandboxes and hold no capacity.
      if (
        status.leases ||
        status.activeIntegrations ||
        status.failedIntegrations ||
        status.completedIntegrations !== 10
      )
        throw new Error("Resources remain after verification")
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  if (!verification)
    throw new Error("Stress run exceeded its observation deadline")
  const timings = stressTimings(events)
  if (timings.findings.length) throw new Error(timings.findings.join("; "))
  if (
    timings.trains.length !== 10 ||
    timings.trains.some(
      (train) =>
        train.workMs === null ||
        train.queueMs === null ||
        train.integrationMs === null
    )
  )
    throw new Error(
      "Durable event log lacks complete timing evidence for the ten Trains"
    )
  if (
    snapshot!.stations.some(
      (station) => station.revisionCount || station.runRetries
    )
  )
    throw new Error(
      "Conflict-free fixture required an unexpected revision or retry"
    )
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
}

const perfSchema = z
  .object({
    complete: z.boolean(),
    records: z.array(z.object({ message: z.string() }).passthrough()),
  })
  .passthrough()
let perfLogs: z.infer<typeof perfSchema> | { available: false; reason: string }
try {
  perfLogs = perfSchema.parse(
    await api(
      `/perf-logs?from=${encodeURIComponent(state.startedAt)}&to=${encodeURIComponent(new Date().toISOString())}`
    )
  )
} catch {
  perfLogs = {
    available: false,
    reason:
      "Perf Tail storage unavailable; durable timings and API samples remain in the report",
  }
}
await save("perf", perfLogs)
await save("events", events)
await save("report", {
  passed: !failure,
  failure,
  run: state,
  finishedAt: new Date().toISOString(),
  verification,
  status,
  timings: stressTimings(events),
  phaseTimings: phaseTimings(
    "records" in perfLogs ? perfLogs.records : undefined,
    snapshot,
    events
  ),
  apiLatency: latencySummary(samples),
  apiSamples: samples,
  observations: observed,
  snapshot,
  perfLogsAvailable: "records" in perfLogs && !!perfLogs.records.length,
  perfLogsComplete: "complete" in perfLogs && perfLogs.complete,
})
console.log(`${failure ? "FAILED" : "PASSED"}: ${output}/report.json`)
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
