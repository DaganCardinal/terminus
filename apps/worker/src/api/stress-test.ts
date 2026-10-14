import { parseRepoId, verifyStressGit } from "@terminus/artifacts"
import {
  PIPELINE_STRESS_PROFILE,
  scriptedStressAgent,
  stressFiles,
  stressTask,
  stressTimings,
  stressReportSchema,
  type NetworkSnapshot,
} from "@terminus/protocol"
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

export async function stressStatus(env: Env, networkId: string) {
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

/** The disposable Network must contain exactly this run, with one Car per Train. */
export function stressOracle(
  snapshot: NetworkSnapshot,
  runId: string,
  baseline: string,
  simulated = false
) {
  if (
    snapshot.trains.length !== 10 ||
    snapshot.lines.length !== 10 ||
    snapshot.stations.length !== 10 ||
    snapshot.cars.length !== 10 ||
    snapshot.holds.length ||
    snapshot.conflicts.length ||
    snapshot.junctions?.length ||
    snapshot.crossings?.length
  )
    throw new DispatchError(
      409,
      "Stress oracle requires exactly ten completed ordinary Lines and Cars, with no holds or conflicts"
    )
  const numbers = new Set<number>()
  for (const station of snapshot.stations) {
    const task = stressTask(station.manifest)
    if (task.runId !== runId || station.state.status !== "complete")
      throw new DispatchError(409, "Unexpected or unfinished stress Station")
    numbers.add(task.train)
  }
  if (numbers.size !== 10)
    throw new DispatchError(409, "Duplicate stress fixture Stations")
  for (const { train } of snapshot.trains) {
    if (
      train.state.status !== "unloaded" ||
      train.terminusBaseline !== baseline ||
      train.state.destination?.kind === "junction"
    )
      throw new DispatchError(
        409,
        "Stress Train did not unload into Terminus from the frozen baseline"
      )
    const cars = snapshot.cars.filter((car) => car.trainId === train.id)
    if (
      cars.length !== 1 ||
      train.carIds.length !== 1 ||
      train.carIds[0] !== cars[0]!.id ||
      cars[0]!.sourceCommit !== baseline ||
      cars[0]!.acceptedCommit !== train.headCommit
    )
      throw new DispatchError(
        409,
        "Stress Car provenance differs from the scenario"
      )
    const car = cars[0]!
    const station = snapshot.stations.find(
      (entry) => entry.id === car.stationId
    )
    const task = stressTask(car.manifest)
    if (
      !station ||
      station.lineId !== train.lineId ||
      JSON.stringify(station.manifest) !== JSON.stringify(car.manifest) ||
      task.runId !== runId ||
      car.stationAgent.harness !==
        (simulated ? "fake" : scriptedStressAgent.harness) ||
      (!simulated && car.review.harness !== scriptedStressAgent.harness) ||
      car.stationAgent.model !==
        (simulated ? "fake" : scriptedStressAgent.model) ||
      car.review.model !== (simulated ? "fake" : scriptedStressAgent.model) ||
      JSON.stringify([...car.changedPaths].sort()) !==
        JSON.stringify(Object.keys(stressFiles(task)).sort()) ||
      car.manifest.expectedEvidence.some(
        (name) =>
          !car.evidence.checks.some(
            (check) =>
              check.name === name && check.required && check.status === "passed"
          )
      )
    )
      throw new DispatchError(
        409,
        "Stress Car lacks its Station, scripted provenance, or independent evidence"
      )
  }
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

export async function verifyStressRun(
  env: Env,
  networkId: string,
  runId: string,
  baseline: string
) {
  stressRepositoryMode(env)
  const snapshot = await new NetworkStore(env.DB).snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const recorded = stressRun(snapshot, stressRepositoryMode(env))
  if (recorded.runId !== runId || recorded.baseline !== baseline)
    throw new DispatchError(
      409,
      "Stress run identity differs from its recorded fixture"
    )
  const oracle = stressOracle(
    snapshot,
    runId,
    baseline,
    env.REPOSITORY_MODE === "fake"
  )
  const status = await stressStatus(env, networkId)
  if (
    status.activeIntegrations ||
    status.failedIntegrations ||
    status.completedIntegrations !== 10
  )
    throw new DispatchError(
      409,
      "Stress integrations did not complete exactly once per Train"
    )
  if (env.REPOSITORY_MODE === "fake") return null
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
  } finally {
    await repositories.revoke(access)
  }
}

/** Explicit verification command. Network lifecycle continues without this report reader. */
export async function stressReport(env: Env, networkId: string) {
  const store = new NetworkStore(env.DB)
  const snapshot = await store.snapshot(networkId)
  if (!snapshot) throw new DispatchError(404, "Unknown network")
  const mode = stressRepositoryMode(env)
  const run = stressRun(snapshot, mode)
  if (
    snapshot.stations.some(
      (station) => station.revisionCount || station.runRetries
    )
  )
    throw new DispatchError(
      409,
      "Stress fixture unexpectedly needed a retry or revision"
    )
  const before = await stressStatus(env, networkId)
  if (before.leases || before.expiredLeases || before.activeIntegrations)
    throw new DispatchError(409, "Stress resources are still active")
  const verification = await verifyStressRun(
    env,
    networkId,
    run.runId,
    run.baseline
  )
  const status = await stressStatus(env, networkId)
  if (status.leases || status.expiredLeases || status.activeIntegrations)
    throw new DispatchError(409, "Resources remain after stress verification")
  const events = []
  for (;;) {
    const page = await store.eventsAfter(networkId, events.at(-1)?.seq ?? 0)
    if (!page.length) break
    events.push(...page)
  }
  const timings = stressTimings(events)
  if (
    timings.findings.length ||
    timings.trains.length !== 10 ||
    timings.trains.some(
      (train) =>
        train.workMs === null ||
        train.queueMs === null ||
        train.integrationMs === null
    )
  )
    throw new DispatchError(
      409,
      "Durable event log lacks valid ten-Train timing evidence"
    )
  return stressReportSchema.parse({
    passed: true,
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
        : "Canonical Git tree, Cars, merge history and resource cleanup verified.",
  })
}
