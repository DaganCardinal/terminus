import { Prose } from "@terminus/ui/components/prose"
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Route } from "lucide-react"
import type { DispatcherTone } from "./dispatcher-state"

/** The Dispatcher's mark. Its colour follows what the Dispatcher is doing. */
export function DispatcherAvatar({
  tone,
  size = "sm",
}: {
  tone: DispatcherTone
  size?: "sm" | "lg"
}) {
  return (
    <span
      className={`dispatcher-avatar dispatcher-avatar-${size} dispatcher-${tone}`}
      aria-hidden="true"
    >
      <Route size={size === "lg" ? 18 : 14} />
      {size === "lg" && tone !== "idle" && <i className="avatar-status" />}
    </span>
  )
}

/** A Line's number in its map colour, as the map and drawers show it. */
export function LineBadge({
  color,
  number,
}: {
  color: string
  number: number
}) {
  return (
    <i className="pline-badge" style={{ "--line": color } as CSSProperties}>
      {number.toString().padStart(2, "0")}
    </i>
  )
}

/** One thing the Dispatcher says in its thread. `meta` is a short line
 * above the text, such as the Line a message is about. */
export function DispatcherMessage({
  tone = "idle",
  meta,
  card = false,
  children,
}: {
  tone?: DispatcherTone
  meta?: ReactNode
  /** Set apart as a card, for things the user needs to act on. */
  card?: boolean
  children: ReactNode
}) {
  return (
    <article className={`dmsg dmsg-${tone} ${card ? "dmsg-card" : ""}`}>
      <DispatcherAvatar tone={tone} />
      <div className="dmsg-body">
        {meta && <div className="dmsg-meta">{meta}</div>}
        {children}
      </div>
    </article>
  )
}

/** What the user asked for, as their side of the thread. */
export function UserMessage({
  text,
  at,
  sending = false,
}: {
  text: string
  at?: string
  sending?: boolean
}) {
  return (
    <div className="umsg">
      <Prose text={text} format="plain" />
      <span className="umsg-meta">
        {sending ? "Sending…" : at ? <Ago at={at} /> : null}
      </span>
    </div>
  )
}

/** Three dots while the Dispatcher works on something it was asked. */
export function Typing() {
  return (
    <span className="typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** Re-renders on an interval, for elapsed and relative times. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export function ago(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })
}

function Ago({ at }: { at: string }) {
  const now = useNow(30_000)
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {ago(at, now)}
    </time>
  )
}
