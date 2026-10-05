import type { NetworkActivity, TrainState } from "@terminus/protocol"

/** The board's remark for a network, like "On time" or "Delayed" on a departures board. */
export interface NetworkRemark {
  tone: "attention" | "moving" | "held" | "review" | "idle" | "new"
  label: string
  detail: string
}

type TrainStatus = TrainState["status"]

/** Trains that are doing something on their own, as opposed to waiting or finished. */
const MOVING: TrainStatus[] = [
  "ready",
  "in_transit",
  "approaching",
  "docked",
  "reviewing",
  "returning",
]

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Summarises a network's activity, most urgent condition first. */
export function networkRemark(activity: NetworkActivity): NetworkRemark {
  const count = (statuses: TrainStatus[]) =>
    statuses.reduce((sum, status) => sum + (activity.trains[status] ?? 0), 0)
  const blocked = count(["blocked"])
  const held = count(["held"])
  const moving = count(MOVING)

  const junctionBlocked = activity.junctions?.blocked ?? 0
  const junctionReady = activity.junctions?.ready ?? 0
  if (blocked > 0 || activity.openConflicts > 0 || junctionBlocked > 0) {
    const parts = [
      blocked > 0 && plural(blocked, "Train") + " blocked",
      junctionBlocked > 0 && plural(junctionBlocked, "Junction") + " blocked",
      activity.openConflicts > 0 &&
        plural(activity.openConflicts, "open conflict"),
    ].filter(Boolean)
    return {
      tone: "attention",
      label: "Needs attention",
      detail: parts.join(" · "),
    }
  }
  if (moving > 0)
    return {
      tone: "moving",
      label: "Running",
      detail:
        plural(moving, "Train") +
        " running" +
        (held > 0 ? ` · ${held} held` : ""),
    }
  if (held > 0)
    return {
      tone: "held",
      label: "Held",
      detail: plural(held, "Train") + " held",
    }
  if (junctionReady > 0)
    return {
      tone: "review",
      label: "Feature ready",
      detail: plural(junctionReady, "Junction") + " awaiting release",
    }
  if (activity.plansAwaitingLaunch > 0)
    return {
      tone: "review",
      label: "Plan ready",
      detail: plural(activity.plansAwaitingLaunch, "plan") + " awaiting launch",
    }
  if (activity.lines === 0)
    return {
      tone: "new",
      label: "No Lines yet",
      detail: "Plan a goal to begin",
    }
  return {
    tone: "idle",
    label: "Idle",
    detail: activity.promotions
      ? plural(activity.promotions, "Train") + " unloaded"
      : "No Trains running",
  }
}

export interface SourceRepository {
  /** `owner/repo` for known forges, otherwise host and path. */
  label: string
  href: string
  host: "github" | "gitlab" | "bitbucket" | "other"
}

/** Turns the public Git URL a network was imported from into a browsable link. */
export function sourceRepository(
  url: string | undefined
): SourceRepository | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "")
  const hostname = parsed.hostname.replace(/^www\./, "")
  const host =
    hostname === "github.com"
      ? "github"
      : hostname === "gitlab.com"
        ? "gitlab"
        : hostname === "bitbucket.org"
          ? "bitbucket"
          : "other"
  return {
    label: host === "other" ? `${hostname}${path}` : path.replace(/^\//, ""),
    href: `${parsed.protocol}//${parsed.host}${path}`,
    host,
  }
}

/** A full Git commit id shortened the conventional way; anything else as-is. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12 min ago", "3 h ago", "Yesterday", "Oct 2". */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso)
  const elapsed = now - then.getTime()
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 2 * DAY) return "Yesterday"
  return then.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  })
}

/** Board time: "14:32" today, otherwise a short date. */
export function boardTime(iso: string, now: number): string {
  const then = new Date(iso)
  const today = new Date(now).toDateString() === then.toDateString()
  return today
    ? then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : then.toLocaleDateString([], { month: "short", day: "numeric" })
}
