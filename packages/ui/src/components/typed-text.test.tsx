import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { startTextReveal, TypedText } from "./typed-text"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function animationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.spyOn(performance, "now").mockReturnValue(1000)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame))
  return {
    frames,
    tick(now: number) {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(now)
    },
  }
}

describe("typed text", () => {
  it("reveals whole graphemes over the configured total duration", () => {
    const animation = animationFrames()
    const reveal = vi.fn()
    const text = "A👩‍💻e\u0301Z"
    startTextReveal(text, 450, reveal)
    animation.tick(1225)
    expect(reveal).toHaveBeenLastCalledWith("A👩‍💻")
    animation.tick(1450)
    expect(reveal).toHaveBeenLastCalledWith(text)
    expect(animation.frames.size).toBe(0)
  })

  it("catches up after a delayed frame and cancels pending work on cleanup", () => {
    const animation = animationFrames()
    const reveal = vi.fn()
    startTextReveal("A much longer activity label", 450, reveal)
    animation.tick(5000)
    expect(reveal).toHaveBeenCalledExactlyOnceWith(
      "A much longer activity label"
    )
    expect(animation.frames.size).toBe(0)
    reveal.mockClear()
    const cancel = startTextReveal("Another label", 450, reveal)
    cancel()
    animation.tick(5200)
    expect(reveal).not.toHaveBeenCalled()
  })

  it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    "shows complete text for duration %s",
    (duration) => {
      const animation = animationFrames()
      const reveal = vi.fn()
      startTextReveal("Ready", duration, reveal)
      animation.tick(1000)
      expect(reveal).toHaveBeenCalledExactlyOnceWith("Ready")
      expect(animation.frames.size).toBe(0)
    }
  )

  it("exposes full accessible text and renders without browser APIs on the server", () => {
    const html = renderToStaticMarkup(<TypedText text="Project exploration" />)
    expect(html).toContain('<span class="sr-only">Project exploration</span>')
    expect(html).toContain(
      'aria-hidden="true" style="grid-area:1 / 1">Project exploration'
    )
  })
})
