import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import { useEffect, useState } from "react"
import { api } from "./api"

const POLL_MS = 1500
const FEED_LIMIT = 300

/**
 * Loads a network snapshot, then polls its event log. New events are
 * appended to the feed and the snapshot is reloaded, so the view never
 * derives state on its own. Key the caller by `networkId` to start fresh
 * when it changes.
 */
export function useNetwork(networkId: string) {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null)
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let after = 0

    async function load() {
      const next = await api.snapshot(networkId)
      if (!cancelled) setSnapshot(next)
    }

    async function poll() {
      try {
        const page = await api.events(networkId, after)
        if (cancelled) return
        if (page.events.length > 0) {
          after = page.lastSeq
          setEvents((feed) => [...feed, ...page.events].slice(-FEED_LIMIT))
          await load()
        }
        setError(null)
      } catch (caught) {
        if (!cancelled) setError(String(caught))
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS)
    }

    load().catch((caught) => setError(String(caught)))
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [networkId])

  return { snapshot, events, error }
}
