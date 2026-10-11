import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import { useEffect, useState } from "react"
import { api } from "./api"
import { pollWhileVisible } from "./poll-while-visible"

const POLL_MS = 1500
const FEED_LIMIT = 300

/** Snapshots own rendered state; events trigger reloads, never transitions.
 * Requests are serialized so a slow initial response cannot overwrite a newer
 * snapshot. A failed snapshot also leaves the event cursor available to retry. */
export function useNetwork(networkId: string) {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null)
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let after = 0
    let loaded = false

    async function load() {
      const next = await api.snapshot(networkId)
      if (!cancelled) {
        setSnapshot(next)
        loaded = true
      }
    }

    async function poll() {
      try {
        if (!loaded) await load()
        if (cancelled) return
        const page = await api.events(networkId, after)
        if (cancelled) return
        if (page.events.length > 0) {
          await load()
          if (cancelled) return
          after = page.lastSeq
          setEvents((feed) => [...feed, ...page.events].slice(-FEED_LIMIT))
        }
        setError(null)
      } catch (caught) {
        if (!cancelled) setError(String(caught))
      }
    }

    const stop = pollWhileVisible(poll, POLL_MS)
    return () => {
      cancelled = true
      stop()
    }
  }, [networkId])

  return { snapshot, events, error }
}
