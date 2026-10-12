import { useEffect, useRef } from "react"
import { useMediaQuery } from "@/components/use-media-query"
import { TRACK_WIDTH } from "./layout"
import { trackSection, type Track } from "./track"

/** A Train and, while it is in transit, the run its Engineer signaled. */
export type SignalingTrain = {
  id: string
  stateEnteredAt: string
  /** Track distances from where the Train set off to the signaled Station. */
  signal: { track: Track; from: number; to: number } | null
}

/** A departure this long ago still pulses when the map first sees it, so a
 * newly launched Line shows its first signal. Older ones never replay. */
const RECENT_MS = 10_000
const SPEED = 1100
/** A bright head and a fading tail, drawn as overlapping dashes. */
const TAIL = [
  { length: 10, opacity: 0.9 },
  { length: 36, opacity: 0.45 },
  { length: 80, opacity: 0.22 },
  { length: 140, opacity: 0.1 },
]
const SVG = "http://www.w3.org/2000/svg"

function pulse(
  layer: SVGGElement,
  { track, from, to }: NonNullable<SignalingTrain["signal"]>
) {
  const run = to - from
  if (run < 4) return
  const d = trackSection(track, from, to)
  // The head runs into the Station and the tail drains in after it.
  const travel = run + TAIL.at(-1)!.length
  const duration = Math.min(1400, Math.max(450, (travel / SPEED) * 1000))
  for (const { length, opacity } of TAIL) {
    const path = document.createElementNS(SVG, "path")
    path.setAttribute("d", d)
    path.setAttribute("class", "signal-pulse")
    path.setAttribute("stroke-width", String(TRACK_WIDTH))
    path.setAttribute("stroke-opacity", String(opacity))
    path.setAttribute("stroke-dasharray", `${length} ${run + travel}`)
    layer.append(path)
    // A dash ending `head` along the path is offset by `length - head`.
    path
      .animate(
        [
          { strokeDashoffset: `${length}px` },
          { strokeDashoffset: `${length - travel}px` },
        ],
        {
          duration,
          easing: "cubic-bezier(0.35, 0, 0.65, 1)",
          fill: "forwards",
        }
      )
      .finished.then(
        () => path.remove(),
        () => path.remove()
      )
  }
}

/**
 * Sends a pulse down the track from a Train to the Station its Engineer has
 * just signaled. It is drawn only for departures seen while the map is open,
 * straight into the returned layer, without re-rendering React.
 */
export function useSignalPulses(trains: SignalingTrain[]) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)")
  const layer = useRef<SVGGElement>(null)
  const seen = useRef(new Map<string, string>())

  useEffect(() => {
    for (const train of trains) {
      const before = seen.current.get(train.id)
      seen.current.set(train.id, train.stateEnteredAt)
      if (!train.signal || before === train.stateEnteredAt) continue
      const recent =
        Math.abs(Date.now() - Date.parse(train.stateEnteredAt)) < RECENT_MS
      if (before === undefined && !recent) continue
      if (layer.current && !reduced) pulse(layer.current, train.signal)
    }
  }, [trains, reduced])

  return layer
}
