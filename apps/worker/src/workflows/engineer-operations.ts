import {
  engineerText,
  type EngineerAdvice,
  type NoticeSituation,
} from "@terminus/agent-runtime"
import {
  ENGINEER_CONFIDENCE_THRESHOLD,
  engineerRecoveryNoticeEligible,
  engineerNoticeCanAssess,
  resolveEngineerNotice,
  recordEngineerNotice,
  engineerWaitMilestone,
  holdsApplyingTo,
  isTerminal,
  type EngineerNotice,
  type Station,
  type Train,
} from "@terminus/domain"
import type { EngineerAssessment } from "@terminus/protocol"
import type { EngineerNetwork } from "../integrations/engineer-store"
import type { TrainPorts } from "./train-operations"

/** Stable identities contain evidence, never wall-clock timestamps from a poll. */
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value))
  )
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export async function assessEngineer<T extends string | boolean>(
  ports: TrainPorts,
  networkId: string,
  trainId: string,
  purpose: EngineerAssessment["purpose"],
  identity: unknown,
  input: unknown,
  ask: () => Promise<EngineerAdvice<T>>
): Promise<EngineerAdvice<T>> {
  const id = await fingerprint({
    trainId,
    purpose,
    identity,
    input,
    model: ports.engineer.model,
    questionVersion: 1,
    threshold: ENGINEER_CONFIDENCE_THRESHOLD,
  })
  const existing = await ports.store.engineer.assessment(id)
  if (existing) return existing.advice as EngineerAdvice<T>
  const advice = await ask()
  const saved = await ports.store.engineer.recordAssessment(networkId, {
    id,
    trainId,
    purpose,
    model: ports.engineer.model,
    questionVersion: 1,
    threshold: ENGINEER_CONFIDENCE_THRESHOLD,
    input,
    advice,
    assessedAt: ports.now(),
  })
  return saved.advice as EngineerAdvice<T>
}

function paused(snapshot: EngineerNetwork, train: Train | undefined): boolean {
  if (!train) return false
  return (
    holdsApplyingTo(train, snapshot.holds).some(
      (hold) => hold.kind === "user"
    ) ||
    (train.state.status === "held" &&
      train.state.reasons.some(
        (reason) =>
          reason.kind === "awaiting_user_approval" ||
          reason.kind === "user_hold"
      ))
  )
}

interface Candidate {
  notice: EngineerNotice
  situation: NoticeSituation
  identity: unknown
  mandatory: boolean
}

async function candidates(
  ports: TrainPorts,
  snapshot: EngineerNetwork,
  train: Train
): Promise<Candidate[]> {
  if (isTerminal(train)) return []
  const result: Candidate[] = []
  if (train.state.status === "held") {
    const gate = await ports.store.engineer.latestTrainGate(
      snapshot.network.id,
      train.id
    )
    for (const reason of train.state.reasons) {
      if (reason.kind !== "dependency") continue
      const station = snapshot.stations.find(
        (station) => station.id === reason.stationId
      )
      if (!station || ["complete", "cancelled"].includes(station.state.status))
        continue
      const source = snapshot.trains.find(
        (view) => view.train.lineId === station.lineId
      )?.train
      if (source?.state.status === "siding") continue // The movement gate owns unresolvable dependencies.
      const blocked =
        station.state.status === "blocked" || source?.state.status === "blocked"
      if (!blocked && (paused(snapshot, train) || paused(snapshot, source)))
        continue
      const progress = await ports.store.engineer.latestProgress(
        snapshot.network.id,
        station.id,
        source?.id
      )
      const pauseEnd = await ports.store.engineer.latestPauseEnd(
        snapshot.network.id,
        [train, ...(source ? [source] : [])]
      )
      const waitingSince = [
        gate?.at,
        progress?.at,
        pauseEnd?.at,
        snapshot.network.createdAt,
      ]
        .filter((at): at is string => !!at)
        .sort()
        .at(-1)!
      const inactiveMs = Math.max(
        0,
        Date.parse(ports.now()) - Date.parse(waitingSince)
      )
      const milestone = engineerWaitMilestone(inactiveMs)
      if (!blocked && milestone === null) continue
      const causeFingerprint = await fingerprint({
        stationId: station.id,
        gate: gate?.seq,
        progress: progress?.seq,
        reviewId: progress?.reviewId,
        pauseEnd: pauseEnd?.seq,
        status: station.state.status,
        trainStatus: source?.state.status,
        blocked,
      })
      const id = await fingerprint({
        trainId: train.id,
        cause: "dependency",
        fingerprint: causeFingerprint,
      })
      const waitingTrains = snapshot.trains.filter(
        (view) =>
          view.train.state.status === "held" &&
          view.train.state.reasons.some(
            (reason) =>
              reason.kind === "dependency" && reason.stationId === station.id
          )
      ).length
      const context = await ports.store.engineer.history(
        snapshot.network.id,
        station.id
      )
      const summary = blocked
        ? `Upstream work at ${engineerText(station.name).slice(0, 200)} is blocked; this Train cannot pick it up yet.`
        : `This Train is waiting for ${engineerText(station.name).slice(0, 200)}; upstream work has made no recorded progress for at least ${milestone} minutes.`
      result.push({
        notice: {
          id,
          trainId: train.id,
          stationId: station.id,
          cause: "dependency",
          fingerprint: causeFingerprint,
          summary,
          dependencyIds: [station.id],
          waitingSince,
          assessedAt: ports.now(),
        },
        situation: {
          train,
          gate: { kind: "hold", reasons: [reason] },
          reason: blocked ? "Upstream blockage" : "Prolonged dependency wait",
          inactiveMinutes: milestone ?? 0,
          dependencies: [
            {
              stationId: station.id,
              name: engineerText(station.name).slice(0, 200),
              status: station.state.status,
              trainStatus: source?.state.status,
              lastProgressAt: progress?.at ?? waitingSince,
              waitingTrains,
              context,
            },
          ],
        },
        identity: { id, milestone, blocked },
        mandatory: blocked,
      })
    }
  }
  const stationId =
    train.state.status === "in_transit"
      ? train.state.toward
      : train.state.status === "docked" || train.state.status === "reviewing"
        ? train.state.at
        : undefined
  const station = snapshot.stations.find((station) => station.id === stationId)
  if (
    station &&
    ["signaled", "active", "revising"].includes(station.state.status)
  ) {
    const events = await ports.store.engineer.events(
      snapshot.network.id,
      station.id
    )
    const incident = events.findLast(
      ({ event }) =>
        event.type === "station.run_failed" || event.type === "station.returned"
    )
    const retried = events.findLast(
      ({ event }) => event.type === "station.run_retried"
    )
    const backoff =
      !!retried &&
      !!incident &&
      retried.seq > incident.seq &&
      retried.event.type === "station.run_retried" &&
      retried.event.backoff
    if (
      incident &&
      engineerRecoveryNoticeEligible({
        retriesUsed: station.retryCount ?? station.revisionCount,
        backoff,
      })
    ) {
      const causeFingerprint = String(incident.seq)
      const id = await fingerprint({
        trainId: train.id,
        cause: "recovery",
        stationId: station.id,
        fingerprint: causeFingerprint,
      })
      const context = await ports.store.engineer.history(
        snapshot.network.id,
        station.id
      )
      result.push({
        notice: {
          id,
          trainId: train.id,
          stationId: station.id,
          cause: "recovery",
          fingerprint: causeFingerprint,
          summary: backoff
            ? `The Engineer paused before retrying ${engineerText(station.name).slice(0, 200)} after a failed run.`
            : `${engineerText(station.name).slice(0, 200)} has needed repeated automatic attempts; work is still continuing.`,
          dependencyIds: [],
          assessedAt: ports.now(),
        },
        situation: {
          train,
          gate: { kind: "clear" },
          context,
          reason: backoff ? "Recovery backoff" : "Repeated automatic attempts",
        },
        identity: { id },
        mandatory: false,
      })
    }
  }
  return result
}

/** Called in its own durable step, after each Train advance, including unchanged holds. */
export async function observeEngineer(
  ports: TrainPorts,
  trainId: string
): Promise<void> {
  const loaded = await ports.store.train(trainId)
  if (!loaded) return
  const snapshot = await ports.store.engineer.snapshot(loaded.networkId)
  if (!snapshot) return
  const possible = await candidates(ports, snapshot, loaded.value)
  const existing = await ports.store.engineer.notices(loaded.networkId, trainId)
  for (const row of existing) {
    if (
      !row.value.resolvedAt &&
      !possible.some((candidate) => candidate.notice.id === row.value.id)
    ) {
      const change = resolveEngineerNotice(row.value, ports.now())
      await ports.store.engineer.saveNotice(
        loaded.networkId,
        change.notice,
        row.version,
        change.events
      )
    }
  }
  for (const candidate of possible) {
    const previous = existing.find(
      (row) => row.value.id === candidate.notice.id
    )
    if (!engineerNoticeCanAssess(previous?.value)) continue
    const advice = candidate.mandatory
      ? { value: true, confidence: 1 }
      : await assessEngineer(
          ports,
          loaded.networkId,
          trainId,
          "notify_dispatcher",
          candidate.identity,
          candidate.situation,
          () => ports.engineer.notifyDispatcher(candidate.situation)
        )
    // A model call can outlive the condition it observed.
    const refreshed = await ports.store.engineer.snapshot(loaded.networkId)
    const current = refreshed?.trains.find(
      (view) => view.train.id === trainId
    )?.train
    if (
      !refreshed ||
      !current ||
      !(await candidates(ports, refreshed, current)).some(
        (next) => next.notice.id === candidate.notice.id
      )
    )
      continue
    if (!advice.value) continue
    // Reload after a model call: acknowledgment is a concurrent Dispatcher command.
    const row = (
      await ports.store.engineer.notices(loaded.networkId, trainId)
    ).find((row) => row.value.id === candidate.notice.id)
    if (!engineerNoticeCanAssess(row?.value)) continue
    const change = recordEngineerNotice(row?.value, {
      ...candidate.notice,
      assessedAt: ports.now(),
    })
    await ports.store.engineer.saveNotice(
      loaded.networkId,
      change.notice,
      row?.version ?? null,
      change.events
    )
  }
}

export function currentStation(train: Train, station: Station): boolean {
  return (
    (train.state.status === "in_transit" &&
      train.state.toward === station.id) ||
    ((train.state.status === "docked" || train.state.status === "reviewing") &&
      train.state.at === station.id)
  )
}
