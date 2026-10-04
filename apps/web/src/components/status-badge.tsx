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

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-1.5 py-0.5 font-mono text-xs",
        tones[toneByStatus[status] ?? "idle"]
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  )
}

export function SignalLamp({ signal }: { signal: "green" | "red" | null }) {
  if (!signal) return null
  return (
    <span
      title={`Signal ${signal}`}
      className={cn(
        "inline-block size-2.5 rounded-full",
        signal === "green" ? "bg-emerald-500" : "bg-red-500"
      )}
    />
  )
}
