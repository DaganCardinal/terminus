/** The slice of `document` polling needs, so tests can stand in for it. */
export interface PageVisibility {
  readonly hidden: boolean
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

/** Runs `task` now and again `intervalMs` after each run finishes, but only
 * while the page is visible. A hidden tab lets the in-flight run finish and
 * schedules nothing; returning to it runs `task` immediately so the view
 * catches up. Runs never overlap, and `task` handles its own errors.
 * Returns a function that stops polling. */
export function pollWhileVisible(
  task: () => Promise<void>,
  intervalMs: number,
  page: PageVisibility = document
): () => void {
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function run() {
    timer = undefined
    running = true
    try {
      await task()
    } finally {
      running = false
    }
    if (!stopped && !page.hidden) timer = setTimeout(run, intervalMs)
  }

  function onVisibilityChange() {
    if (page.hidden) {
      clearTimeout(timer)
      timer = undefined
    } else if (!running && timer === undefined) {
      void run()
    }
  }

  page.addEventListener("visibilitychange", onVisibilityChange)
  if (!page.hidden) void run()

  return () => {
    stopped = true
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", onVisibilityChange)
  }
}
