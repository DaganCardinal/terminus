/** Advisory Dispatcher metadata; it never changes a Train gate. */
export interface EngineerNotice {
  id: string
  trainId: string
  stationId?: string
  cause: "recovery" | "dependency"
  fingerprint: string
  summary: string
  dependencyIds: string[]
  assessedAt: string
  waitingSince?: string
  acknowledgedAt?: string
  resolvedAt?: string
}

/** Assess unchanged waits at 30, 60, 120 minutes, then every two hours. */
export function engineerWaitMilestone(inactiveMs: number): number | null {
  const minutes = Math.max(0, inactiveMs) / 60_000
  if (minutes < 30) return null
  if (minutes < 60) return 30
  if (minutes < 120) return 60
  return Math.floor(minutes / 120) * 120
}

export function engineerRecoveryNoticeEligible(input: {
  retriesUsed: number
  backoff: boolean
}): boolean {
  return input.backoff || input.retriesUsed >= 2
}

/** Suppression is per incident, so a new fingerprint can report again. */
export function engineerNoticeCanAssess(notice?: EngineerNotice): boolean {
  return !notice?.acknowledgedAt && !notice?.resolvedAt
}

export function acknowledgeEngineerNotice(
  notice: EngineerNotice,
  at: string
): {
  notice: EngineerNotice
  events: import("./events").DomainEvent[]
} {
  if (!engineerNoticeCanAssess(notice)) return { notice, events: [] }
  return {
    notice: { ...notice, acknowledgedAt: at },
    events: [
      {
        type: "dispatcher.engineer_notice_acknowledged",
        trainId: notice.trainId,
        noticeId: notice.id,
      },
    ],
  }
}

export function resolveEngineerNotice(
  notice: EngineerNotice,
  at: string
): {
  notice: EngineerNotice
  events: import("./events").DomainEvent[]
} {
  if (notice.resolvedAt) return { notice, events: [] }
  return {
    notice: { ...notice, resolvedAt: at },
    events: [
      {
        type: "dispatcher.engineer_notice_resolved",
        trainId: notice.trainId,
        noticeId: notice.id,
      },
    ],
  }
}

export function recordEngineerNotice(
  previous: EngineerNotice | undefined,
  next: EngineerNotice
): {
  notice: EngineerNotice
  events: import("./events").DomainEvent[]
} {
  if (previous && previous.id !== next.id)
    throw new Error("Cannot overwrite a different Engineer incident")
  if (!engineerNoticeCanAssess(previous))
    return { notice: previous!, events: [] }
  return {
    notice: next,
    events: previous
      ? []
      : [
          {
            type: "dispatcher.engineer_notice_raised",
            trainId: next.trainId,
            noticeId: next.id,
            summary: next.summary,
          },
        ],
  }
}
