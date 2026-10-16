import { prepareJunctionTopology } from "../agents/junctions"
import {
  resolveLineRoute,
  validateCrossingTopology,
  assessPlan,
  launchProposal,
  hasNewCollisionForecasts,
  createLine,
  createTrain,
  failDispatchPlan,
  finishPlanLaunch,
  launchDispatchPlan,
  readyDispatchPlan,
  type DomainEvent,
  type BaselineReport,
  type DispatchPlan,
  type DispatchProposal,
} from "@terminus/domain"
import {
  baselineReportSchema,
  dispatchProposalSchema,
  errorDetail,
} from "@terminus/protocol"
import { DispatchProposalError } from "@terminus/agent-runtime"
import { NonRetryableError } from "cloudflare:workflows"
import {
  planningContext,
  type DispatchPlanningPorts,
} from "../agents/dispatch-planning"
import type { Write } from "../integrations/network-store"
import { DispatchError, orderedPlans } from "../agents/dispatcher"
import { applied } from "./transitions"
import { defaultValidation } from "../integrations/execution-config"
import type { DispatchActivityRecorder } from "../integrations/dispatch-activity"
import { SANDBOX_CAPACITY_MESSAGE } from "../integrations/sandbox-capacity"

export async function prepareDispatchPlan(
  ports: DispatchPlanningPorts,
  planId: string
): Promise<void> {
  const loaded = await load(ports, planId)
  if (loaded.value.state.status !== "planning") return
  const plan = loaded.value
  if (plan.model !== ports.planner.model)
    throw new Error("Dispatcher configuration changed; request a new plan")
  const snapshot = await ports.store.snapshot(plan.networkId)
  if (!snapshot) throw new Error("Unknown network")
  let proposal: DispatchProposal
  let baseline: BaselineReport | undefined
  let activity: DispatchActivityRecorder | undefined
  try {
    activity = await ports.activity?.begin(planId)
  } catch {
    console.warn("Dispatcher activity persistence unavailable")
  }
  try {
    const current = await load(ports, planId)
    if (current.value.state.status !== "planning") return
    const revised = plan.revises
      ? (await ports.store.dispatchPlan(plan.revises))?.value
      : undefined
    const revisedProposal =
      revised && "proposal" in revised.state
        ? revised.state.proposal
        : undefined
    const result = await ports.planner.plan({
      ...(plan.request ? { request: plan.request } : {}),
      ...(plan.revises
        ? {
            revision: {
              planId: plan.revises,
              ...(revisedProposal ? { proposal: revisedProposal } : {}),
            },
          }
        : {}),
      planId,
      goal: plan.goal,
      network: planningContext(snapshot),
      repository: {
        repoId: snapshot.network.terminusRepoId,
        commit: plan.terminusCommit,
      },
      checkBaseline: !!plan.checkBaseline,
      validation: snapshot.network.validation ?? defaultValidation,
      onActivity: activity?.observe,
    })
    proposal = dispatchProposalSchema.parse(result.proposal)
    if (result.baseline) {
      baseline = baselineReportSchema.parse(result.baseline)
      if (baseline.commit !== plan.terminusCommit)
        throw new Error("Baseline checks describe a different commit")
    }
    activity?.observe({ kind: "phase", phase: "saving_proposal" })
  } catch (error) {
    if (error instanceof DispatchProposalError) {
      // The Dispatcher already used its bounded corrections in-session. Do not repeat them blindly.
      await recordDispatchFailure(ports, planId, "planning", error)
      throw new NonRetryableError(error.message)
    }
    throw error
  } finally {
    await activity?.close()
  }
  const current = await load(ports, planId)
  if (current.value.state.status !== "planning") return
  const ready = applied(
    readyDispatchPlan(plan, proposal, planningContext(snapshot), baseline)
  )
  await ports.store.commit(
    plan.networkId,
    [{ kind: "dispatch_plan", plan: ready.value, version: loaded.version }],
    ready.events
  )
}

/** Forks stable identities, then atomically records every Line and its Train. No Train runs before this batch. */
export async function layDispatchLines(
  ports: DispatchPlanningPorts,
  planId: string
): Promise<void> {
  try {
    await layLines(ports, planId)
  } catch (error) {
    if (!(error instanceof DispatchError) || error.status === 503) throw error
    // A refused plan stays refused, so retrying cannot help. Record why.
    await recordDispatchFailure(ports, planId, "launching", error)
    throw new NonRetryableError(error.message)
  }
}

async function layLines(
  ports: DispatchPlanningPorts,
  planId: string
): Promise<void> {
  const loaded = await load(ports, planId)
  const plan = loaded.value
  if (plan.state.status !== "launching") return
  const snapshot = await ports.store.snapshot(plan.networkId)
  if (!snapshot) throw new Error("Unknown network")
  if (snapshot.network.terminusCommit !== plan.terminusCommit)
    throw new DispatchError(409, "Terminus changed before launch")
  const assessment = assessPlan(
    plan.state.proposal,
    planningContext(snapshot),
    plan.state.baseline
  )
  // An included baseline fix is laid as its own Line, with Crossings on the others.
  const proposal = launchProposal(plan.state.proposal)
  if (assessment.errors.length)
    throw new DispatchError(
      409,
      `Network changes made the plan invalid: ${assessment.errors.join("; ")}`
    )
  if (hasNewCollisionForecasts(plan.state.assessment, assessment))
    throw new DispatchError(
      409,
      "New collision forecasts appeared before launch"
    )
  const writes: Write[] = []
  const events: DomainEvent[] = []
  const lineIds: string[] = []
  const trainIds: string[] = []
  const allIds = new Map<string, string>(
    proposal.lines.flatMap((l, index) =>
      l.stations.map((s, i) => [s.key, `${plan.id}-l${index}-s${i}`] as const)
    )
  )
  const allPlanned = [
    ...proposal.lines.map((l, index) => ({
      ...l,
      id: `${plan.id}-l${index}`,
    })),
    ...(proposal.junctions ?? []).flatMap((j, index) => {
      const id = `${plan.id}-junction-${index}`
      return [
        ...j.incoming.map((l, i) => ({
          ...l,
          id: `${id}-l${i}`,
          destination: { kind: "junction" as const, junctionId: id },
        })),
        {
          ...j.outgoing,
          id: `${id}-l${j.incoming.length}`,
          origin: { kind: "junction" as const, junctionId: id },
        },
      ]
    }),
  ]
  for (const l of allPlanned)
    for (const [n, station] of l.stations.entries())
      allIds.set(station.key, `${l.id}-s${n}`)
  const resolved = allPlanned.map((l) => {
    const made = applied(
      createLine({
        id: l.id,
        name: l.name,
        networkId: plan.networkId,
        ...("origin" in l ? { origin: l.origin } : {}),
        ...("destination" in l ? { destination: l.destination } : {}),
        stations: orderedPlans(l.stations, l.route).map((s) => ({
          id: allIds.get(s.key)!,
          name: s.name,
          manifest: {
            ...s.manifest,
            dependencies: s.manifest.dependencies.map(
              (d) => allIds.get(d) ?? d
            ),
          },
        })),
      })
    )
    return {
      ...made.value,
      ...resolveLineRoute(made.value.line, l.route, allIds),
    }
  })
  const topologyContext = {
    keys: allIds,
    lines: [...snapshot.lines, ...resolved.map((t) => t.line)],
    stations: [...snapshot.stations, ...resolved.flatMap((t) => t.stations)],
  }
  const topologyErrors = validateCrossingTopology(
    topologyContext.lines,
    topologyContext.stations
  )
  if (topologyErrors.length)
    throw new DispatchError(409, topologyErrors.join("; "))
  // Forks are independent and named stably, so they run together. All settle
  // before a failure is reported, so a retry never races a fork still running.
  const settled = await Promise.allSettled(
    proposal.lines.map((_, index) =>
      ports.repositories.fork({
        sourceRepoId: snapshot.network.terminusRepoId,
        commit: plan.terminusCommit,
        name: `${plan.id}-t${index}`,
      })
    )
  )
  const repos = settled.map((fork) => {
    if (fork.status === "rejected") throw fork.reason
    return fork.value
  })
  for (const [index, planned] of proposal.lines.entries()) {
    const lineId = `${plan.id}-l${index}`
    const trainId = `${plan.id}-t${index}`
    const ids = allIds
    const created = applied(
      createLine({
        id: lineId,
        networkId: plan.networkId,
        name: planned.name,
        stations: orderedPlans(planned.stations, planned.route).map(
          (station) => ({
            id: ids.get(station.key)!,
            name: station.name,
            manifest: {
              ...station.manifest,
              dependencies: station.manifest.dependencies.map(
                (key) => ids.get(key) ?? key
              ),
            },
          })
        ),
      })
    )
    const resolved = resolveLineRoute(created.value.line, planned.route, ids)
    created.value.line = resolved.line
    const repo = repos[index]!
    const train = applied(
      createTrain({
        id: trainId,
        line: created.value.line,
        repoId: repo.repoId,
        terminusCommit: plan.terminusCommit,
      })
    )
    writes.push(
      ...resolved.crossings.map((crossing): Write => ({
        kind: "crossing",
        crossing,
        version: null,
      })),
      { kind: "line", line: created.value.line },
      ...created.value.stations.map((station): Write => ({
        kind: "station",
        station,
        version: null,
      })),
      { kind: "train", train: train.value, version: null },
      {
        kind: "unload_policy",
        policy: {
          trainId,
          mode:
            planned.unloadMode ?? planned.unloadRecommendation?.mode ?? "auto",
          ...(planned.unloadRecommendation
            ? { recommendation: planned.unloadRecommendation }
            : {}),
        },
        version: null,
      }
    )
    events.push(
      ...created.events,
      ...train.events,
      ...resolved.crossings.map((c) => ({
        type: "crossing.created" as const,
        crossingId: c.id,
        trainId,
        stationId: c.sourceStationId,
      }))
    )
    lineIds.push(lineId)
    trainIds.push(trainId)
  }
  for (const [index, planned] of (proposal.junctions ?? []).entries()) {
    const feature = await prepareJunctionTopology(
      ports,
      plan.networkId,
      {
        name: planned.name,
        brief: planned.brief,
        incoming: planned.incoming,
        outgoing: planned.outgoing,
        requestId: "00000000-0000-4000-8000-000000000000",
      },
      (await ports.store.roleModels(plan.networkId)).conductor,
      `${plan.id}-junction-${index}`,
      topologyContext
    )
    writes.push(...feature.writes)
    events.push(...feature.events)
    lineIds.push(
      ...feature.junction.incomingLineIds,
      feature.junction.outgoingLineId
    )
    trainIds.push(...feature.junction.incomingTrainIds)
  }
  const started = applied(
    launchDispatchPlan(
      { ...plan, state: { ...plan.state, assessment } },
      lineIds,
      trainIds
    )
  )
  const topology = validateCrossingTopology(
    [
      ...snapshot.lines,
      ...writes
        .filter((w): w is Extract<Write, { kind: "line" }> => w.kind === "line")
        .map((w) => w.line),
    ],
    [
      ...snapshot.stations,
      ...writes
        .filter(
          (w): w is Extract<Write, { kind: "station" }> => w.kind === "station"
        )
        .map((w) => w.station),
    ]
  )
  if (topology.length) throw new DispatchError(409, topology.join("; "))
  writes.sort(
    (a, b) => (a.kind === "crossing" ? 1 : 0) - (b.kind === "crossing" ? 1 : 0)
  )
  // Version and canonical-baseline triggers abort the WHOLE batch on a stale launch.
  writes.unshift({
    kind: "dispatch_plan",
    plan: started.value,
    version: loaded.version,
  })
  await ports.store.commit(plan.networkId, writes, [
    ...events,
    ...started.events,
  ])
}

export async function startDispatchTrains(
  ports: DispatchPlanningPorts,
  planId: string
): Promise<void> {
  const loaded = await load(ports, planId)
  const plan = loaded.value
  if (plan.state.status !== "starting") return
  for (const j of await ports.store.junctions(plan.networkId))
    if (j.id.startsWith(`${plan.id}-junction-`)) {
      if (!ports.startJunction)
        throw new Error("Junction workflow starter unavailable")
      await ports.startJunction(j.id)
    }
  await Promise.all(plan.state.trainIds.map((id) => ports.startTrain(id)))
  const finished = applied(finishPlanLaunch(plan))
  await ports.store.commit(
    plan.networkId,
    [{ kind: "dispatch_plan", plan: finished.value, version: loaded.version }],
    finished.events
  )
}

export async function recordDispatchFailure(
  ports: DispatchPlanningPorts,
  planId: string,
  phase: "planning" | "launching",
  /** Why it failed. Only a Dispatcher or Terminus refusal's own message is
   * shown; any other failure is described by its kind. */
  failure?: unknown
): Promise<void> {
  const loaded = await load(ports, planId)
  if (loaded.value.state.status !== phase) return
  // Never expose repository blobs, model output, or transport errors in persisted diagnostics.
  const failed = applied(
    failDispatchPlan(
      loaded.value,
      failure instanceof DispatchProposalError ||
        (failure instanceof DispatchError && failure.status !== 503)
        ? `${phase === "launching" ? "Launch refused: " : ""}${failure.message}. Request a new plan.`
        : phase === "planning"
          ? planningFailureMessage(failure)
          : "Lines could not be laid against the saved Terminus baseline. Request a fresh plan against the current network."
    )
  )
  await ports.store.commit(
    loaded.networkId,
    [{ kind: "dispatch_plan", plan: failed.value, version: loaded.version }],
    failed.events
  )
}

/** Kinds of planning failure, matched in order, each with what to tell the user. */
const planningFailures: {
  matches: (message: string, classes: string[]) => boolean
  message: string
}[] = [
  {
    matches: (message) => message.startsWith(SANDBOX_CAPACITY_MESSAGE),
    message:
      "Planning could not start: every agent Sandbox this network may run was busy. Wait for running work to finish or raise the limit in Settings, then request a new plan.",
  },
  {
    matches: (message) =>
      /^Configure (the )?AI_GATEWAY_|^Alternative harness execution is disabled|^Dispatcher configuration changed/.test(
        message
      ),
    message:
      "Planning could not start: the Dispatcher's model or harness configuration is incomplete, or changed after the plan was requested. Check Settings and the Worker configuration, then request a new plan.",
  },
  {
    matches: (message) =>
      /\bexited with -?\d+\b|did not produce a final message|stream ended without an outcome/.test(
        message
      ),
    message:
      "Planning failed: the Dispatcher's agent stopped before it finished the plan. Request a new plan.",
  },
  {
    matches: (_, classes) => classes.includes("timeout"),
    message:
      "Planning failed: it ran out of time before the plan was finished. Request a new plan, or narrow the goal.",
  },
  {
    matches: (_, classes) => classes.includes("memory"),
    message:
      "Planning failed: the planning Sandbox ran out of memory. Request a new plan.",
  },
  {
    matches: (_, classes) =>
      ["container-exited", "connection-lost", "object-reset"].some((kind) =>
        classes.includes(kind)
      ),
    message:
      "Planning failed: the planning Sandbox stopped unexpectedly. Request a new plan.",
  },
  {
    matches: (_, classes) => classes.includes("overloaded"),
    message:
      "Planning failed: the model or Sandbox service was overloaded. Wait a moment, then request a new plan.",
  },
]

/**
 * Says why planning failed without repeating the error, which can carry model
 * output or credentials: only the kind of failure is described.
 */
export function planningFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  const classes = (errorDetail(error) ?? "").split(/[ |]/)
  return (
    planningFailures.find((failure) => failure.matches(message, classes))
      ?.message ??
    "Dispatcher could not prepare a valid proposal. Check Worker configuration and diagnostics, then request a new plan."
  )
}

async function load(ports: DispatchPlanningPorts, planId: string) {
  const plan = await ports.store.dispatchPlan(planId)
  if (!plan) throw new Error("Unknown plan")
  return plan
}

export async function dispatchPlanState(
  ports: DispatchPlanningPorts,
  planId: string
): Promise<DispatchPlan["state"]["status"]> {
  return (await load(ports, planId)).value.state.status
}
