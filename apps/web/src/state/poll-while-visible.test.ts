import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pollWhileVisible, type PageVisibility } from "./poll-while-visible"

function fakePage(hidden = false) {
  const listeners = new Set<() => void>()
  const page = {
    hidden,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
    setHidden(next: boolean) {
      page.hidden = next
      for (const listener of listeners) listener()
    },
    listeners,
  }
  return page satisfies PageVisibility
}

describe("pollWhileVisible", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("polls on an interval while visible", async () => {
    const task = vi.fn(async () => {})
    const stop = pollWhileVisible(task, 1000, fakePage())
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(4)
    stop()
  })

  it("stops while hidden and catches up immediately on return", async () => {
    const page = fakePage()
    const task = vi.fn(async () => {})
    const stop = pollWhileVisible(task, 1000, page)
    await vi.advanceTimersByTimeAsync(0)
    page.setHidden(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(task).toHaveBeenCalledTimes(1)

    page.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(3)
    stop()
  })

  it("waits for a tab opened in the background to become visible", async () => {
    const page = fakePage(true)
    const task = vi.fn(async () => {})
    const stop = pollWhileVisible(task, 1000, page)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(task).not.toHaveBeenCalled()
    page.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    stop()
  })

  it("never overlaps a run still in flight when the tab returns", async () => {
    const page = fakePage()
    let finish!: () => void
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const stop = pollWhileVisible(task, 1000, page)
    page.setHidden(true)
    page.setHidden(false)
    expect(task).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
    stop()
  })

  it("stops scheduling and listening once stopped", async () => {
    const page = fakePage()
    const task = vi.fn(async () => {})
    const stop = pollWhileVisible(task, 1000, page)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(task).toHaveBeenCalledTimes(1)
    expect(page.listeners.size).toBe(0)
  })
})
