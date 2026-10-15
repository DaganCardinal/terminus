import {
  parseRepoId,
  StressGitMismatchError,
  verifyStressGit,
} from "@terminus/artifacts"
import {
  PIPELINE_STRESS_PROFILE,
  scriptedStressAgent,
  stressFiles,
  stressReportPending,
  stressInterventions,
  stressTask,
  stressTimings,
  stressReportSchema,
  type NetworkSnapshot,
  type StressStatus,
  type StressTask,
} from "@terminus/protocol"
import type { WorkManifest } from "@terminus/domain"
import { DispatchError } from "../agents/dispatcher"
import { artifactsRepositories } from "../integrations/artifacts-repositories"
import { NetworkStore } from "../integrations/network-store"
import { SandboxWorkspaces } from "../integrations/sandbox-workspaces"
import { stressRun } from "../agents/stress-test"

export function stressRepositoryMode(env: Env): "artifacts" | "fake" {
  if (env.REPOSITORY_MODE !== "artifacts" && env.REPOSITORY_MODE !== "fake")
    throw new DispatchError(503, "Configure Artifacts or fake repositories")
  return env.REPOSITORY_MODE
}

export async function stressStatus(
  env: Env,
  networkId: string
): Promise<StressStatus> {
  stressRepositoryMode(env)
  const network = await new NetworkStore(env.DB).network(networkId)
  if (!network) throw new DispatchError(404, "Unknown network")
  const namespace = parseRepoId(network.terminusRepoId).namespace
  const [leases, attempts] = await env.DB.batch<{
    live?: number | null
    expired?: number | null
    status?: string
    count?: number
  }>([
    env.DB.prepare(
      "SELECT SUM(expires_at > ?) AS live, SUM(expires_at <= ?) AS expired FROM sandbox_leases WHERE namespace = ?"
    ).bind(Date.now(), Date.now(), namespace),
    env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM integration_attempts WHERE network_id = ? GROUP BY status"
    ).bind(networkId),
  ])
  const counts = new Map(
    attempts!.results.map((row) => [row.status ?? "", Number(row.count)])
  )
  return {
    profile: PIPELINE_STRESS_PROFILE,
    leases: Number(leases!.results[0]?.live ?? 0),
    expiredLeases: Number(leases!.results[0]?.expired ?? 0),
    activeIntegrations:
      (counts.get("cleared") ?? 0) + (counts.get("prepared") ?? 0),
    completedIntegrations: counts.get("completed") ?? 0,
    failedIntegrations: counts.get("failed") ?? 0,
  }
}

function fixtureTask(manifest: WorkManifest): StressTask | null {
  try {
    return stressTask(manifest)
  } catch {
    return null
  }
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}

/** Findings name Trains by fixture number, as the map's Line names do. */
function trainLabels(snapshot: NetworkSnapshot): (trainId: string) => string {
  const numbers = new Map<string, number>()
  for (const station of snapshot.stations) {
    const task = fixtureTask(station.manifest)
    if (task) numbers.set(station.lineId, task.train)
  }
  return (trainId) => {
    const lineId = snapshot.trains.find(({ train }) => train.id === trainId)
      ?.train.lineId
    const number = lineId === undefined ? undefined : numbers.get(lineId)
    return number === undefined ? `Train ${trainId}` : `Train ${number}`
  }
}

function describeState(state: { status: string }): string {
  const detail =
    "issues" in state && Array.isArray(state.issues)
      ? (state.issues as { detail: string }[])
          .map((issue) => issue.detail)
          .join("; ")
      : "reason" in state && typeof state.reason === "string"
        ? state.reason
        : "phase" in state && typeof state.phase === "string"
          ? state.phase
          : ""
  return detail ? `${state.status} (${detail.slice(0, 300)})` : state.status
}

/**
 * Every way the recorded Network differs from the scenario, each naming its
 * Train and the failed check. Empty when the run matches.
 */
export function stressFindings(
  snapshot: NetworkSnapshot,
  runId: string,
  baseline: string,
  simulated = false
): string[] {
  const findings: string[] = []
  const label = trainLabels(snapshot)
  const counts = {
    Lines: snapshot.lines.length,
    Trains: snapshot.trains.length,
    Stations: snapshot.stations.length,
    Cars: snapshot.cars.length,
  }
  for (const [name, count] of Object.entries(counts))
    if (count !== 10) findings.push(`Expected 10 ${name}, found ${count}`)
  const extras = {
    holds: snapshot.holds.length,
    conflicts: snapshot.conflicts.length,
    Junctions: snapshot.junctions?.length ?? 0,
    Crossings: snapshot.crossings?.length ?? 0,
  }
  for (const [name, count] of Object.entries(extras))
    if (count) findings.push(`Expected no ${name}, found ${count}`)
  const numbers = new Set<number>()
  for (const station of snapshot.stations) {
    const task = fixtureTask(station.manifest)
    if (!task) {
      findings.push(
        `Station ${station.id}: manifest differs from the versioned fixture`
      )
      continue
    }
    const name = `Train ${task.train}`
    if (task.runId !== runId)
      findings.push(`${name}: Station belongs to stress run ${task.runId}`)
    if (numbers.has(task.train))
      findings.push(`${name}: duplicate fixture Station ${station.id}`)
    numbers.add(task.train)
    if (station.state.status !== "complete")
      findings.push(
        `${name}: Station is ${describeState(station.state)}, expected complete`
      )
  }
  const harness = simulated ? "fake" : scriptedStressAgent.harness
  const model = simulated ? "fake" : scriptedStressAgent.model
  for (const { train } of snapshot.trains) {
    const name = label(train.id)
    if (train.state.status !== "unloaded")
      findings.push(`${name}: ${describeState(train.state)}, expected unloaded`)
    else if (train.state.destination?.kind === "junction")
      findings.push(`${name}: unloaded into a Junction, expected Terminus`)
    if (train.terminusBaseline !== baseline)
      findings.push(
        `${name}: Terminus baseline ${train.terminusBaseline} is not the frozen baseline ${baseline}`
      )
    const cars = snapshot.cars.filter((car) => car.trainId === train.id)
    const car = cars[0]
    if (
      !car ||
      cars.length !== 1 ||
      train.carIds.length !== 1 ||
      train.carIds[0] !== car.id
    ) {
      findings.push(
        `${name}: expected one Car, found ${cars.length} (${train.carIds.length} on the Train)`
      )
      continue
    }
    if (car.sourceCommit !== baseline)
      findings.push(
        `${name} Car provenance: source commit ${car.sourceCommit} is not the frozen baseline`
      )
    if (car.acceptedCommit !== train.headCommit)
      findings.push(
        `${name} Car provenance: accepted commit ${car.acceptedCommit} is not the Train head ${train.headCommit}`
      )
    const station = snapshot.stations.find(
      (entry) => entry.id === car.stationId
    )
    if (!station || station.lineId !== train.lineId)
      findings.push(
        `${name} Car provenance: Station ${car.stationId} is not on this Train's Line`
      )
    else if (JSON.stringify(station.manifest) !== JSON.stringify(car.manifest))
      findings.push(`${name} Car provenance: manifest differs from its Station`)
    const task = fixtureTask(car.manifest)
    if (task?.runId !== runId)
      findings.push(
        `${name} Car provenance: manifest is not this run's fixture`
      )
    if (
      car.stationAgent.harness !== harness ||
      car.stationAgent.model !== model
    )
      findings.push(
        `${name} Car provenance: Station Agent ${car.stationAgent.harness}/${car.stationAgent.model}, expected ${harness}/${model}`
      )
    if (
      (!simulated && car.review.harness !== harness) ||
      car.review.model !== model
    )
      findings.push(
        `${name} Car provenance: Conductor ${car.review.harness}/${car.review.model}, expected ${simulated ? "model " : `${harness}/`}${model}`
      )
    if (task) {
      const expected = Object.keys(stressFiles(task))
      const outside = car.changedPaths.filter(
        (path) => !expected.includes(path)
      )
      const missing = expected.filter(
        (path) => !car.changedPaths.includes(path)
      )
      if (outside.length || missing.length)
        findings.push(
          `${name} Car changed paths differ from the fixture: ${[
            ...missing.map((path) => `missing ${path}`),
            ...outside.map((path) => `unexpected ${path}`),
          ].join(", ")}`
        )
    }
    const unmet = car.manifest.expectedEvidence.flatMap((check) => {
      const found = car.evidence.checks.find((entry) => entry.name === check)
      if (!found) return [`${check} (missing)`]
      if (!found.required) return [`${check} (not required)`]
      return found.status === "passed" ? [] : [`${check} (${found.status})`]
    })
    if (unmet.length)
      findings.push(
        `${name} Car lacks passing independent evidence: ${unmet.join(", ")}`
      )
  }
  return findings
}

/** The disposable Network must contain exactly this run, with one Car per Train. */
export function stressOracle(
  snapshot: NetworkSnapshot,
  runId: string,
  baseline: string,
  simulated = false
) {
  const findings = stressFindings(snapshot, runId, baseline, simulated)
  if (findings.length)
    throw new DispatchError(409, findings.join("; "), { findings })
  return {
    baseline,
    head: snapshot.network.terminusCommit,
    integrationCommits: snapshot.trains.flatMap(({ train }) =>
      train.state.status === "unloaded" ? [train.state.mergeCommit] : []
    ),
    acceptedCommits: snapshot.cars.map((car) => car.acceptedCommit),
    files: Object.assign(
      {},
      ...Array.from({ length: 10 }, (_, i) =>
        stressFiles({ runId, train: i + 1 })
      )
    ) as Record<string, string>,
  }
}

function integrationFindings(status: StressStatus): string[] {
  return status.activeIntegrations ||
    status.failedIntegrations ||
    status.completedIntegrations !== 10
    ? [
        `Expected exactly ten completed integrations into Terminus; found ${status.completedIntegrations} completed, ${status.failedIntegrations} failed, ${status.activeIntegrations} active`,
      ]
    : []
}

/** A 409 from verification carries its individual findings. */
function errorFindings(error: DispatchError): string[] {
  const details = error.details as { findings?: unknown } | undefined
  return Array.isArray(details?.findings)
    ? details.findings.map(String)
    : [error.message]
}

export async function verifyStressRun(
  env: Env,
  networkId: string,
  runId: string,
  baseline: string
) {
  const mode = stressRepositoryMode(env)
  const snapshot = await new NetworkStore(env.DB).snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const recorded = stressRun(snapshot, mode)
  if (recorded.runId !== runId || recorded.baseline !== baseline)
    throw new DispatchError(
      409,
      "Stress run identity differs from its recorded fixture"
    )
  const oracle = stressOracle(snapshot, runId, baseline, mode === "fake")
  const counts = integrationFindings(await stressStatus(env, networkId))
  if (counts.length)
    throw new DispatchError(409, counts.join("; "), { findings: counts })
  if (mode === "fake") return null
  const repositories = artifactsRepositories(env)
  const access = await repositories.access(
    snapshot.network.terminusRepoId,
    "read"
  )
  try {
    const workspace = await new SandboxWorkspaces(env).open([access])
    try {
      const result = await verifyStressGit(workspace, access, oracle)
      const store = new NetworkStore(env.DB)
      const current = await store.network(networkId)
      if (
        current?.terminusCommit !== oracle.head ||
        (await store.lastSeq(networkId)) !== snapshot.lastSeq
      )
        throw new DispatchError(
          409,
          "Network changed during stress verification"
        )
      return result
    } finally {
      await workspace.close()
    }
  } catch (error) {
    if (error instanceof DispatchError) throw error
    if (error instanceof StressGitMismatchError)
      throw new DispatchError(409, error.message, { findings: error.findings })
    // Infrastructure failures are retryable and say nothing about the run.
    throw new DispatchError(
      503,
      `Canonical Git verification could not complete: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await repositories.revoke(access)
  }
}

/**
 * Explicit verification command. Network lifecycle continues without this
 * report reader. Once every Train has stopped, it returns a report either
 * way; a failed run lists its findings instead of refusing.
 */
export async function stressReport(env: Env, networkId: string) {
  const store = new NetworkStore(env.DB)
  const snapshot = await store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const mode = stressRepositoryMode(env)
  const run = stressRun(snapshot, mode)
  const before = await stressStatus(env, networkId)
  const pending = stressReportPending(snapshot, before)
  if (pending) throw new DispatchError(409, `Not ready to verify: ${pending}`)
  const label = trainLabels(snapshot)
  const findings: string[] = []
  for (const station of snapshot.stations)
    if (station.revisionCount || station.runRetries) {
      const task = fixtureTask(station.manifest)
      findings.push(
        `${task ? `Train ${task.train}` : `Station ${station.id}`}: Station needed ${plural(station.revisionCount, "revision")} and ${plural(station.runRetries ?? 0, "run retry", "run retries")}`
      )
    }
  findings.push(
    ...stressFindings(snapshot, run.runId, run.baseline, mode === "fake"),
    ...integrationFindings(before)
  )
  const events = []
  for (;;) {
    const page = await store.eventsAfter(networkId, events.at(-1)?.seq ?? 0)
    if (!page.length) break
    events.push(...page)
  }
  findings.push(...stressInterventions(events, label))
  const timings = stressTimings(events)
  findings.push(...timings.findings)
  for (const { train } of snapshot.trains) {
    if (train.state.status !== "unloaded") continue
    const row = timings.trains.find((entry) => entry.trainId === train.id)
    const missing = (["workMs", "queueMs", "integrationMs"] as const).filter(
      (key) => row?.[key] === null || row?.[key] === undefined
    )
    if (missing.length)
      findings.push(
        `${label(train.id)}: durable events lack ${missing.join(", ")} timing`
      )
  }
  let verification = null
  if (!findings.length)
    try {
      verification = await verifyStressRun(
        env,
        networkId,
        run.runId,
        run.baseline
      )
    } catch (error) {
      if (!(error instanceof DispatchError) || error.status !== 409) throw error
      findings.push(...errorFindings(error))
    }
  const status = await stressStatus(env, networkId)
  if (status.leases || status.activeIntegrations)
    findings.push(
      `Resources remained after verification: ${plural(status.leases, "Sandbox lease")}, ${plural(status.activeIntegrations, "active integration")}`
    )
  const warnings = before.expiredLeases
    ? [
        `${plural(before.expiredLeases, "expired Sandbox lease row")} remained from Sandboxes that stopped without releasing their slot, for example across a deploy; capacity no longer counts them`,
      ]
    : []
  return stressReportSchema.parse({
    passed: !findings.length,
    findings,
    warnings,
    mode,
    run,
    verification,
    status,
    timings,
    events,
    snapshot,
    verifiedAt: new Date().toISOString(),
    note:
      mode === "fake"
        ? "Local rehearsal: simulated repositories and agents. Cloudflare Artifacts/Sandbox capacity and final Git tree are not verified."
        : findings.length
          ? "Verification failed; see findings. Canonical Git checks run only after every recorded check passes."
          : "Canonical Git tree, Cars, merge history and resource cleanup verified.",
  })
}
