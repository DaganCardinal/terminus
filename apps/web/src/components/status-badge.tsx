import { cn } from "@terminus/ui/lib/utils"

const tones: Record<string, string> = {
  moving: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  review: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  held: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blocked: "bg-destructive/15 text-destructive",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  idle: "bg-muted text-muted-foreground",
}

const toneByStatus: Record<string, keyof typeof tones> = {
  in_transit: "moving",
  approaching: "moving",
  signaled: "moving",
  active: "moving",
  docked: "review",
  reviewing: "review",
  ready_for_pickup: "review",
  in_review: "review",
  revising: "review",
  held: "held",
  blocked: "blocked",
  complete: "done",
  returning: "done",
  unloaded: "done",
}

/** Statuses where work is underway, so their dot pulses. */
const pulsing = new Set([
  "in_transit",
  "approaching",
  "docked",
  "reviewing",
  "blocked",
  "returning",
  "signaled",
  "active",
  "ready_for_pickup",
  "in_review",
  "revising",
])

const toneFor = (status: string) => toneByStatus[status] ?? "idle"

/** `ready_for_pickup` → "Ready for pickup". */
const label = (status: string) => {
  const words = status.replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function StatusBadge({
  status,
  dot = false,
}: {
  status: string
  /** Leads with a status dot that pulses while work is underway. */
  dot?: boolean
}) {
  const tone = toneFor(status)
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium",
        tones[tone]
      )}
    >
      {dot && (
        <i
          aria-hidden="true"
          className={cn(
            "status-dot",
            `status-dot-${tone}`,
            pulsing.has(status) && "status-dot-pulse"
          )}
        />
      )}
      {label(status)}
    </span>
  )
}
