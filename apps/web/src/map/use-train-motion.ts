import { useLayoutEffect, useRef } from "react"
import { useMediaQuery } from "@/components/use-media-query"
import {
  isMoving,
  trainDistance,
  type RouteLayout,
  type TrainMotion,
} from "./layout"
import { pointOnTrack } from "./track"

export type MovingTrain = {
  id: string
  motion: TrainMotion
  route: RouteLayout
}

/** Stiffness of the critically damped spring that pulls a drawn Train toward
 * its target: any gap, such as the run into a Station once its work is
 * ready, closes to within 1% in about 4 seconds without overshooting. */
const SPRING = 1.7
const FRAME_MS = 1000 / 30

type Drawn = { distance: number; velocity: number }

/** Exact spring step for a fixed target, so long or missed frames stay stable. */
function settle(drawn: Drawn, target: number, seconds: number): Drawn {
  const offset = drawn.distance - target
  const push = drawn.velocity + SPRING * offset
  const decay = Math.exp(-SPRING * seconds)
  const next = {
    distance: target + (offset + push * seconds) * decay,
    velocity: (drawn.velocity - SPRING * push * seconds) * decay,
  }
  return Math.abs(next.distance - target) < 0.25 && Math.abs(next.velocity) < 1
    ? { distance: target, velocity: 0 }
    : next
}

/**
 * Places Train markers along their tracks and keeps moving ones moving. Each
 * frame derives a target from Train state and the clock, so polling, reloads
 * and missed frames never knock a Train off course. Markers are moved through
 * their `transform` directly, without re-rendering React.
 */
export function useTrainMotion(trains: MovingTrain[]) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)")
  const markers = useRef(new Map<string, SVGGElement>())
  const shown = useRef(new Map<string, Drawn>())
  const refs = useRef(new Map<string, (marker: SVGGElement | null) => void>())

  const lastDraw = useRef<number | null>(null)

  useLayoutEffect(() => {
    let frame = 0
    const draw = (time: number) => {
      const elapsed =
        lastDraw.current === null
          ? 0
          : Math.max(0, (time - lastDraw.current) / 1000)
      lastDraw.current = time
      const now = Date.now()
      let active = false
      for (const { id, motion, route } of trains) {
        const marker = markers.current.get(id)
        const target = trainDistance(motion, route, now)
        if (!marker || target === null) continue
        const before = shown.current.get(id)
        const drawn =
          before && !reduced
            ? settle(before, target, elapsed)
            : { distance: target, velocity: 0 }
        shown.current.set(id, drawn)
        const p = pointOnTrack(route.track, drawn.distance)
        marker.setAttribute("transform", `translate(${p.x} ${p.y})`)
        if (drawn.distance !== target || isMoving(motion)) active = true
      }
      if (active && !reduced) frame = requestAnimationFrame(tick)
    }
    const tick = (time: number) => {
      if (lastDraw.current !== null && time - lastDraw.current < FRAME_MS)
        frame = requestAnimationFrame(tick)
      else draw(time)
    }
    // Re-renders (polls, panning) place markers before the browser paints,
    // continuing from the last frame rather than restarting the clock.
    draw(performance.now())
    return () => cancelAnimationFrame(frame)
  }, [trains, reduced])

  /** A stable ref callback per Train, so re-renders keep its drawn position. */
  return (id: string) => {
    let ref = refs.current.get(id)
    if (!ref) {
      ref = (marker) => {
        if (marker) markers.current.set(id, marker)
        else {
          markers.current.delete(id)
          shown.current.delete(id)
        }
      }
      refs.current.set(id, ref)
    }
    return ref
  }
}
