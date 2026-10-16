import {
  finishedLineOutcome,
  lineIdentities,
  lineMarking,
  stationWheres,
  type BriefLine,
  type NetworkBrief,
  type NetworkSnapshot,
} from "@terminus/protocol"
import type { TrainLocation, TrainState } from "@terminus/domain"

/** Finished Lines described beyond this many are only counted. */
const FINISHED_LINES = 30
const RECENT_PLANS = 10
/** About 5,000 tokens. Over this, quiet live Lines shrink to a count. */
export const BRIEF_BUDGET_CHARS = 20_000

const firstLine = (text: string, limit: number) => {
  const line = text.split("\n")[0]!.trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function location(at: TrainLocation): string {
  return at.kind === "depot"
    ? "depot"
    : at.kind === "station"
      ? `at ${at.stationId}`
      : `at junction ${at.junctionId}`
}

/** Where a Train is, in words the model can follow. */
export function trainWhere(state: TrainState): string {
  switch (state.status) {
    case "ready":
      return location(state.at)
    case "in_transit":
      return `travelling toward ${state.toward}`
    case "approaching":
      return `approaching ${state.toward}`
    case "docked":
    case "reviewing":
      return `at ${state.at}`
    case "returning":
      return state.phase === "integrating"
        ? "integrating into its destination"
        : "waiting for clearance to its destination"
    case "held":
    case "blocked":
      return state.resume.status === "ready"
        ? location(state.resume.at)
        : "waiting for clearance to its destination"
    case "unloaded":
      return "unloaded"
    case "siding":
      return "on the siding"
  }
}

/**
 * The Dispatcher's view of the network at the start of a turn: what needs
 * attention, what is running and where its work is, recent plans and what
 * finished. Built from one snapshot, so every round of a turn sees the same
 * state. Text in it was written by users and models; the prompt labels it
 * as untrusted data.
 */
export function buildNetworkBrief(
  snapshot: NetworkSnapshot,
  asOf: string,
  budgetChars = BRIEF_BUDGET_CHARS
): NetworkBrief {
  const identities = lineIdentities(snapshot)
  const wheres = stationWheres(snapshot, identities)
  const lineName = new Map(snapshot.lines.map((l) => [l.id, l.name]))
  const trainOf = (lineId: string) =>
    snapshot.trains.find(({ train }) => train.lineId === lineId)?.train

  const blockedTrains = snapshot.trains.flatMap(({ train }) =>
    train.state.status === "blocked"
      ? [
          {
            trainId: train.id,
            line: lineName.get(train.lineId) ?? train.lineId,
            ...(train.state.resume.status === "ready" &&
            train.state.resume.at.kind === "station"
              ? { stationId: train.state.resume.at.stationId }
              : {}),
            issues: train.state.issues.map(
              (issue) => `${issue.kind}: ${firstLine(issue.detail, 300)}`
            ),
          },
        ]
      : []
  )
  const attention: NetworkBrief["attention"] = {
    blockedTrains,
    openConflicts: snapshot.conflicts
      .filter((c) => c.status === "open")
      .map((c) => ({
        conflictId: c.id,
        trainId: c.trainIds[0] ?? "",
        paths: c.paths.slice(0, 10),
      })),
    conflictReports: (snapshot.conflictConcerns ?? [])
      .filter((c) => c.pair.stage === "confirmed")
      .map((c) => ({
        trainId: c.trainId,
        summary: firstLine(
          c.pair.investigation?.finding?.summary ??
            c.pair.investigation?.summary ??
            "Possible conflict reported",
          300
        ),
      })),
    engineerNotices: (snapshot.engineerNotices ?? []).map((n) => ({
      trainId: n.trainId,
      summary: firstLine(n.summary, 300),
    })),
    awaitingApproval: snapshot.trains.flatMap(({ train }) =>
      train.state.status === "held" &&
      train.state.reasons.some((r) => r.kind === "awaiting_user_approval")
        ? [
            {
              trainId: train.id,
              line: lineName.get(train.lineId) ?? train.lineId,
            },
          ]
        : []
    ),
    repairsAwaitingApproval: (snapshot.repairs ?? [])
      .filter((r) => r.state.status === "ready")
      .map((r) => ({ repairId: r.id, trainId: r.source.trainId })),
  }
  const needsAttention = new Set([
    ...blockedTrains.map((t) => t.trainId),
    ...attention.openConflicts.flatMap(
      (c) => snapshot.conflicts.find((x) => x.id === c.conflictId)!.trainIds
    ),
    ...attention.conflictReports.map((c) => c.trainId),
    ...attention.engineerNotices.map((n) => n.trainId),
    ...attention.awaitingApproval.map((t) => t.trainId),
    ...attention.repairsAwaitingApproval.map((r) => r.trainId),
  ])

  const live = snapshot.lines.filter(
    (line) => identities.get(line.id)?.live !== false
  )
  const fullLine = (line: (typeof live)[number]): BriefLine => {
    const train = trainOf(line.id)
    const policy = snapshot.unloadPolicies?.find((p) => p.trainId === train?.id)
    return {
      id: line.id,
      name: line.name,
      ...lineMarking(identities.get(line.id)!),
      destination:
        line.destination?.kind === "junction"
          ? `junction ${line.destination.junctionId}`
          : "terminus",
      ...(policy ? { unloadMode: policy.mode } : {}),
      ...(train
        ? {
            train: {
              id: train.id,
              status: train.state.status,
              at: trainWhere(train.state),
              holds:
                train.state.status === "held"
                  ? train.state.reasons.map((r) => r.kind)
                  : [],
              cars: train.carIds.length,
            },
          }
        : {}),
      stations: snapshot.stations
        .filter((s) => s.lineId === line.id)
        .map((s) => ({
          id: s.id,
          name: s.name,
          status: s.state.status,
          where: wheres.get(s.id) ?? "waiting",
          goal: firstLine(s.manifest.goal, 200),
          expectedAreas: s.manifest.expectedAreas.slice(0, 10),
          contracts: s.manifest.contracts.map((c) => c.name),
          dependencies: s.manifest.dependencies,
        })),
    }
  }
  const countLine = (line: (typeof live)[number]): BriefLine => {
    const counts = new Map<string, number>()
    const stations = snapshot.stations.filter((s) => s.lineId === line.id)
    for (const s of stations) {
      const where = wheres.get(s.id) ?? "waiting"
      counts.set(where, (counts.get(where) ?? 0) + 1)
    }
    return {
      id: line.id,
      name: line.name,
      ...lineMarking(identities.get(line.id)!),
      summary: `${stations.length} ${stations.length === 1 ? "Station" : "Stations"}: ${[
        ...counts,
      ]
        .map(([where, n]) => `${n} ${where}`)
        .join(", ")}`,
    }
  }

  const finished = snapshot.lines
    .filter((line) => identities.get(line.id)?.live === false)
    .sort((a, b) =>
      identities
        .get(b.id)!
        .finishedAt!.localeCompare(identities.get(a.id)!.finishedAt!)
    )
  const brief: NetworkBrief = {
    network: {
      name: snapshot.network.name,
      terminusCommit: snapshot.network.terminusCommit,
      asOf,
    },
    attention,
    liveLines: live.map(fullLine),
    recentPlans: snapshot.plans
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, RECENT_PLANS)
      .map((plan) => ({
        id: plan.id,
        goal: firstLine(plan.goal, 120),
        status:
          plan.state.status === "failed" && plan.state.reason
            ? plan.state.reason
            : plan.state.status,
        lineIds:
          plan.state.status === "starting" || plan.state.status === "launched"
            ? plan.state.lineIds
            : [],
        ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      })),
    finishedLines: finished.slice(0, FINISHED_LINES).map((line) => ({
      name: line.name,
      outcome: finishedLineOutcome(snapshot, line),
      finishedAt: identities.get(line.id)!.finishedAt!,
      stations: snapshot.stations
        .filter((s) => s.lineId === line.id)
        .map((s) => s.name),
    })),
    ...(finished.length > FINISHED_LINES
      ? { olderFinishedLines: finished.length - FINISHED_LINES }
      : {}),
  }
  // Over budget, quiet Lines shrink to counts, largest first; their details
  // stay one tool call away. Lines that need attention keep theirs.
  if (JSON.stringify(brief).length > budgetChars) {
    const quiet = live
      .filter((line) => {
        const train = trainOf(line.id)
        return !train || !needsAttention.has(train.id)
      })
      .sort(
        (a, b) =>
          JSON.stringify(fullLine(b)).length -
          JSON.stringify(fullLine(a)).length
      )
    for (const line of quiet) {
      const index = brief.liveLines.findIndex((l) => l.id === line.id)
      brief.liveLines[index] = countLine(line)
      if (JSON.stringify(brief).length <= budgetChars) break
    }
  }
  return brief
}
