import { useEffect, useState } from "react"
import type {
  DispatchActivityResponse,
  AgentActivityEntry,
} from "@terminus/protocol"
import { api } from "./api"
import { pollWhileVisible } from "./poll-while-visible"

type ActivityFeed = {
  attempt: string | null
  entries: AgentActivityEntry[]
  lastSeq: number
}
const empty: ActivityFeed = { attempt: null, entries: [], lastSeq: 0 }

export function mergeDispatchActivity(
  feed: ActivityFeed,
  page: DispatchActivityResponse
): ActivityFeed {
  const previous = feed.attempt === page.attempt ? feed.entries : []
  const entries = new Map(previous.map((entry) => [entry.seq, entry]))
  for (const entry of page.entries) entries.set(entry.seq, entry)
  const sorted = [...entries.values()].sort((a, b) => a.seq - b.seq)
  const recent = sorted.slice(-199)
  const phase = sorted.findLast((entry) => entry.activity.kind === "phase")
  if (phase && !recent.includes(phase)) recent.unshift(phase)
  return {
    attempt: page.attempt,
    entries: recent,
    lastSeq: page.lastSeq,
  }
}

export function useDispatchActivity(
  networkId: string,
  planId: string,
  running: boolean,
  visible: boolean
) {
  const [result, setResult] = useState({
    planId,
    feed: empty,
    unavailable: false,
  })
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let feed = empty
    async function poll() {
      try {
        let page: DispatchActivityResponse
        do {
          page = await api.planActivity(networkId, planId, feed.lastSeq)
          if (cancelled) return
          feed = mergeDispatchActivity(feed, page)
          setResult({ planId, feed, unavailable: false })
        } while (page.hasMore)
        return true
      } catch {
        if (!cancelled)
          setResult((before) => ({ ...before, unavailable: true }))
        return false
      }
    }
    let stop = () => {}
    stop = pollWhileVisible(async () => {
      const loaded = await poll()
      if (!running && loaded) stop()
    }, 1500)
    return () => {
      cancelled = true
      stop()
    }
  }, [networkId, planId, running, visible])
  return result.planId === planId
    ? result
    : { planId, feed: empty, unavailable: false }
}
