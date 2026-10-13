import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"
function subscribeReducedMotion(notify: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}
const prefersReducedMotion = () => window.matchMedia(reducedMotionQuery).matches
const serverReducedMotion = () => true

/** Animation driver; elapsed time bounds the reveal even after a background-tab pause. */
export function startTextReveal(
  text: string,
  durationMs: number,
  reveal: (text: string) => void
): () => void {
  // Reveal whole graphemes, keeping emoji and combining characters intact.
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment
  )
  const start = performance.now()
  let frame: number
  const tick = (now: number) => {
    const progress =
      Number.isFinite(durationMs) && durationMs > 0
        ? Math.min(1, Math.max(0, (now - start) / durationMs))
        : 1
    reveal(
      characters.slice(0, Math.floor(progress * characters.length)).join("")
    )
    if (progress < 1) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

export type TypedTextProps = Omit<ComponentProps<"span">, "children"> & {
  text: string
  /** Total reveal duration, independent of text length. Zero disables animation. */
  durationMs?: number
  animate?: boolean
}

/** Reveals initial text once. Changed text appears immediately; use a new key to replay. */
export function TypedText({
  text,
  durationMs = 450,
  animate = true,
  style,
  ...props
}: TypedTextProps) {
  const [initial] = useState({ text, animate })
  const [visible, setVisible] = useState("")
  const [complete, setComplete] = useState(!animate)
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    serverReducedMotion
  )
  const revealing =
    !complete &&
    initial.animate &&
    animate &&
    initial.text === text &&
    !reducedMotion &&
    Number.isFinite(durationMs) &&
    durationMs > 0

  useEffect(() => {
    if (complete) return
    if (!revealing) {
      const frame = requestAnimationFrame(() => setComplete(true))
      return () => cancelAnimationFrame(frame)
    }
    return startTextReveal(text, durationMs, (next) => {
      setVisible(next)
      if (next === text) setComplete(true)
    })
  }, [complete, revealing, text, durationMs])

  return (
    <span {...props} style={{ ...style, display: "inline-grid" }}>
      {/* Reserve the full layout without exposing duplicate accessible text. */}
      <span
        aria-hidden="true"
        style={{ gridArea: "1 / 1", visibility: "hidden" }}
      >
        {text}
      </span>
      <span aria-hidden="true" style={{ gridArea: "1 / 1" }}>
        {revealing ? visible : text}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  )
}
